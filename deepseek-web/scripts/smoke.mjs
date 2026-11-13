import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "../server/mcp-server.mjs");
const argv = new Set(process.argv.slice(2));

const mode = argv.has("--live")
  ? "live"
  : argv.has("--missing-key")
    ? "missing-key"
    : "protocol";

const env = { ...process.env };
if (mode === "missing-key") {
  delete env.DEEPSEEK_WEB_API_KEY;
  delete env.DEEPSEEK_API_KEY;
}
if (
  mode === "live" &&
  !env.DEEPSEEK_WEB_API_KEY &&
  !env.DEEPSEEK_API_KEY
) {
  console.error(
    "--live 需要设置 DEEPSEEK_WEB_API_KEY 或 DEEPSEEK_API_KEY 环境变量。",
  );
  process.exit(2);
}

function assert(condition, label) {
  if (!condition) throw new Error(`断言失败：${label}`);
}

const child = spawn(process.execPath, [serverPath], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const pending = new Map();
let nextId = 1;
let childExited = false;

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    console.error(`[client] 非 JSON 输出：${trimmed.slice(0, 300)}`);
    return;
  }
  if (message.id === undefined || message.id === null) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) {
    entry.reject(new Error(JSON.stringify(message.error)));
  } else {
    entry.resolve(message.result);
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[server] ${chunk}`);
});

child.on("exit", (code) => {
  childExited = true;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(`server exited with code ${code}`));
  }
  pending.clear();
});

function request(method, params, timeoutMs = 45000) {
  if (childExited) return Promise.reject(new Error("server 已退出"));
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  const promise = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`等待 ${method} 超时`));
    }, timeoutMs);
    pending.set(id, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    });
  });
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return promise;
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function main() {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "deepseek-web-smoke", version: "0.1.2" },
  });
  assert(init.serverInfo?.name === "deepseek-web", "serverInfo.name");
  console.log("serverInfo:", init.serverInfo);
  notify("notifications/initialized", {});

  const list = await request("tools/list", {});
  assert(Array.isArray(list.tools), "tools/list 返回 tools 数组");
  assert(list.tools.length === 2, `期望 2 个工具，实际 ${list.tools.length}`);
  const names = list.tools.map((tool) => tool.name).sort();
  assert(names.join(",") === "web_fetch,web_search", `工具名：${names}`);
  console.log("✓ initialize / tools/list");

  if (mode === "missing-key") {
    const result = await request("tools/call", {
      name: "web_search",
      arguments: { queries: ["DeepSeek V4 release"], max_results: 1 },
    });
    assert(result.isError === true, "缺 Key 时应返回 isError");
    const text = result.content?.[0]?.text || "";
    assert(/API Key/i.test(text), "缺 Key 错误信息应提示 API Key");
    console.log("✓ 缺 Key 错误路径");
  }

  if (mode === "live") {
    console.log("→ 真实 web_search ...");
    const search = await request(
      "tools/call",
      {
        name: "web_search",
        arguments: {
          queries: [
            "DeepSeek V4 release",
            "DeepSeek V4 官方 发布",
          ],
          max_results: 5,
          ori_question: "DeepSeek V4 最近发布了吗？",
        },
      },
      60000,
    );
    assert(search.isError !== true, `search 返回错误：${search.content?.[0]?.text}`);
    const searchText = search.content?.[0]?.text || "";
    assert(/URL: https?:\/\//u.test(searchText), "搜索结果应包含 URL");
    console.log(searchText.slice(0, 1500));
    console.log("✓ 真实 web_search");

    console.log("→ 真实 web_fetch ...");
    const fetched = await request(
      "tools/call",
      {
        name: "web_fetch",
        arguments: { url: "https://api-docs.deepseek.com/guides/search" },
      },
      60000,
    );
    assert(fetched.isError !== true, `fetch 返回错误：${fetched.content?.[0]?.text}`);
    const fetchText = fetched.content?.[0]?.text || "";
    assert(fetchText.length > 200, "抓取正文过短");
    console.log(fetchText.slice(0, 1000));
    console.log("✓ 真实 web_fetch");
  }

  console.log(`\n烟测通过（mode=${mode}）`);
}

try {
  await main();
  child.stdin.end();
  child.kill();
  process.exit(0);
} catch (error) {
  console.error(`\n烟测失败：${error.message}`);
  child.stdin.end();
  child.kill();
  process.exit(1);
}
