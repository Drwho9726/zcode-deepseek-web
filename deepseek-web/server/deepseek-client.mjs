import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

const USER_AGENT = "zcode-deepseek-web/0.1.2";
const MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const HTTP_HINTS = {
  400: "请求参数不合法（检查 query/count/url 的格式与长度）。",
  401: "DeepSeek API Key 无效或未配置。请在插件配置中填写 DeepSeek API Key，或设置 DEEPSEEK_API_KEY 环境变量；如果当前环境有原生联网工具，可直接改用原生工具。",
  402: "DeepSeek 账户余额不足，请充值后重试；也可改用原生联网工具。",
  403: "DeepSeek 安全策略拒绝了这次抓取；换一个 URL、改用 web_search，或改用原生抓取工具。",
  404: "目标页面无法抓取或没有可读内容；换一个 URL、改用 web_search，或改用原生抓取工具。",
  408: "DeepSeek 读取请求体超时，正在重试；仍失败则改用原生联网工具。",
  413: "请求体过大；缩短 query 或 URL。",
  429: "触发 DeepSeek 限流（Search 100 QPS / Fetch 25 QPS），正在等待重试；仍失败则改用原生联网工具。",
  500: "DeepSeek 服务内部错误，正在重试；仍失败则改用原生联网工具。",
  502: "DeepSeek 网关错误，正在重试；仍失败则改用原生联网工具。",
  503: "DeepSeek 服务暂不可用，正在重试；仍失败则改用原生联网工具。",
  504: "DeepSeek 下游超时，正在重试；仍失败则改用原生联网工具。",
};

export class DeepSeekWebError extends Error {
  constructor(message, { code = "DEEPSEEK_WEB_ERROR", status, retryable = false, retryAfterMs } = {}) {
    super(message);
    this.name = "DeepSeekWebError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanSecret(value) {
  const text = String(value ?? "").trim();
  if (!text || text.includes("${")) return "";
  return text;
}

export function normalizeBaseUrl(raw) {
  const candidate = String(raw ?? "").trim();
  const input =
    !candidate || candidate.includes("${")
      ? "https://api.deepseek.com/v1/tools"
      : candidate;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new DeepSeekWebError(`DEEPSEEK_WEB_BASE_URL 不是合法 URL：${input}`, {
      code: "CONFIG_ERROR",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DeepSeekWebError("DEEPSEEK_WEB_BASE_URL 只支持 http/https。", {
      code: "CONFIG_ERROR",
    });
  }
  let pathname = url.pathname.replace(/\/+$/u, "");
  pathname = pathname.replace(/\/(?:search|fetch)$/u, "");
  if (!pathname) pathname = "/v1/tools";
  else if (pathname === "/v1") pathname = "/v1/tools";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

export function resolveConfig(env = process.env) {
  return {
    apiKey:
      cleanSecret(env.DEEPSEEK_WEB_API_KEY) ||
      cleanSecret(env.DEEPSEEK_API_KEY),
    baseUrl: normalizeBaseUrl(env.DEEPSEEK_WEB_BASE_URL),
    defaultCount: clampInteger(env.DEEPSEEK_WEB_DEFAULT_COUNT, 10, 1, 50),
    maxSummaryChars: clampInteger(
      env.DEEPSEEK_WEB_MAX_SUMMARY_CHARS,
      800,
      100,
      20000,
    ),
    requestsPerSecond: clampInteger(env.DEEPSEEK_WEB_RPS, 5, 1, 20),
    timeoutMs: clampInteger(env.DEEPSEEK_WEB_TIMEOUT_MS, 30000, 1000, 120000),
    fetchMaxChars: clampInteger(
      env.DEEPSEEK_WEB_FETCH_MAX_CHARS,
      200000,
      1000,
      2000000,
    ),
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeepSeekWebError("请求已取消。", { code: "ABORTED" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DeepSeekWebError("请求已取消。", { code: "ABORTED" }));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class RateLimiter {
  constructor(requestsPerSecond) {
    this.intervalMs = Math.max(1, Math.ceil(1000 / requestsPerSecond));
    this.nextAt = 0;
    this.chain = Promise.resolve();
  }

  acquire(signal) {
    const run = this.chain.then(() => this.#wait(signal));
    this.chain = run.catch(() => {});
    return run;
  }

  async #wait(signal) {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
    if (waitMs > 0) await sleep(waitMs, signal);
  }
}

function decompressBuffer(buffer, contentEncoding) {
  const encoding = String(contentEncoding ?? "").toLowerCase().trim();
  if (!encoding || encoding === "identity") return buffer;
  try {
    if (encoding.includes("gzip")) return zlib.gunzipSync(buffer);
    if (encoding.includes("br")) return zlib.brotliDecompressSync(buffer);
    if (encoding.includes("deflate")) {
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    }
  } catch (error) {
    throw new DeepSeekWebError(`无法解压 DeepSeek 响应：${error.message}`, {
      code: "DECOMPRESSION_ERROR",
    });
  }
  return buffer;
}

function retryAfterMsFromHeaders(headers) {
  const raw = headers?.["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(raw));
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function mapHttpError(status, apiMessage, headers) {
  const hint = HTTP_HINTS[status] || `DeepSeek 返回 HTTP ${status}。`;
  const detail = String(apiMessage ?? "").replace(/\s+/gu, " ").trim();
  const suffix = detail ? ` ${detail.slice(0, 500)}` : "";
  return new DeepSeekWebError(`${hint}${suffix}`, {
    code: `HTTP_${status}`,
    status,
    retryable: RETRYABLE_STATUS.has(status),
    retryAfterMs: retryAfterMsFromHeaders(headers),
  });
}

function wrapNetworkError(error) {
  if (error instanceof DeepSeekWebError) return error;
  const code = error?.code || "NETWORK_ERROR";
  const retryable = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENOTFOUND",
  ]).has(code);
  return new DeepSeekWebError(`网络请求失败：${error?.message || String(error)}`, {
    code,
    retryable,
  });
}

function requestOnce(urlString, body, config, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "http:" ? http : https;
    const payload = JSON.stringify(body);
    const headers = {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "accept-encoding": "gzip, deflate, br",
      "user-agent": USER_AGENT,
      "content-length": Buffer.byteLength(payload),
    };

    let settled = false;
    let req;
    let timer;
    let onAbort;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    req = transport.request(url, { method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("aborted", () => {
        finish(
          reject,
          new DeepSeekWebError("DeepSeek 响应被中断。", {
            code: "RESPONSE_ABORTED",
            retryable: true,
          }),
        );
      });
      res.on("error", (error) => finish(reject, wrapNetworkError(error)));
      res.on("end", () => {
        const status = res.statusCode || 0;
        let parsed = null;
        let text = "";
        try {
          const decompressed = decompressBuffer(
            Buffer.concat(chunks),
            res.headers["content-encoding"],
          );
          text = decompressed.toString("utf8");
          parsed = text ? JSON.parse(text) : null;
        } catch (error) {
          if (error instanceof DeepSeekWebError) {
            finish(reject, error);
            return;
          }
          // A non-JSON body is handled below, with the HTTP status.
        }

        if (status >= 200 && status < 300) {
          if (parsed === null || typeof parsed !== "object") {
            finish(
              reject,
              new DeepSeekWebError(
                `DeepSeek 返回了无法解析的响应（HTTP ${status}）。`,
                { code: "INVALID_RESPONSE", status },
              ),
            );
            return;
          }
          finish(resolve, parsed);
          return;
        }

        const apiMessage =
          parsed?.error?.message ?? parsed?.message ?? text.slice(0, 500);
        finish(reject, mapHttpError(status, apiMessage, res.headers));
      });
    });

    timer = setTimeout(() => {
      req.destroy(
        new DeepSeekWebError(`请求超时（${config.timeoutMs}ms）。`, {
          code: "TIMEOUT",
          retryable: true,
        }),
      );
    }, config.timeoutMs);

    onAbort = () => {
      req.destroy(new DeepSeekWebError("请求已取消。", { code: "ABORTED" }));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("error", (error) => finish(reject, wrapNetworkError(error)));
    req.end(payload);
  });
}

function mapSearchResponse(data) {
  if (!data || !Array.isArray(data.results)) {
    throw new DeepSeekWebError("DeepSeek Search 响应缺少 results 数组。", {
      code: "INVALID_RESPONSE",
    });
  }
  const results = [];
  for (const item of data.results) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.url !== "string" || !item.url.trim()) continue;
    results.push({
      title: typeof item.title === "string" ? item.title : "",
      url: item.url.trim(),
      snippet: typeof item.snippet === "string" ? item.snippet : "",
      summary: typeof item.summary === "string" ? item.summary : "",
      date:
        typeof item.date === "string" && item.date.trim()
          ? item.date.trim()
          : undefined,
      siteName:
        typeof item.site_name === "string" && item.site_name.trim()
          ? item.site_name.trim()
          : undefined,
      authority: Number.isInteger(item.authority) ? item.authority : undefined,
      rerankScore:
        typeof item.rerank_score === "number" ? item.rerank_score : undefined,
    });
  }
  if (data.results.length > 0 && results.length === 0) {
    throw new DeepSeekWebError("DeepSeek Search 返回的结果都缺少有效 url。", {
      code: "INVALID_RESPONSE",
    });
  }
  return { results };
}

function mapFetchResponse(data, requestedUrl) {
  if (!data || typeof data !== "object" || typeof data.content !== "string") {
    throw new DeepSeekWebError("DeepSeek Fetch 响应缺少 content 字符串。", {
      code: "INVALID_RESPONSE",
    });
  }
  return {
    url: requestedUrl,
    title: typeof data.title === "string" ? data.title.trim() : "",
    content: data.content,
  };
}

export function createClient(config) {
  const limiter = new RateLimiter(config.requestsPerSecond);

  async function post(path, body, signal) {
    if (!config.apiKey) {
      throw new DeepSeekWebError(
        "未配置 DeepSeek API Key。请在插件配置中填写 DeepSeek API Key，或设置 DEEPSEEK_API_KEY 环境变量；如果当前环境有原生联网/抓取工具，也可直接改用原生工具。",
        { code: "MISSING_API_KEY" },
      );
    }
    const url = `${config.baseUrl}${path}`;
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await limiter.acquire(signal);
        return await requestOnce(url, body, config, signal);
      } catch (error) {
        lastError = error;
        const canRetry =
          error instanceof DeepSeekWebError &&
          error.retryable &&
          attempt < MAX_RETRIES &&
          !signal?.aborted;
        if (!canRetry) throw error;
        const backoff =
          error.retryAfterMs ??
          500 * 2 ** attempt + Math.floor(Math.random() * 200);
        await sleep(backoff, signal);
      }
    }
    throw lastError;
  }

  return {
    config,
    async search({ query, count, oriQuestion }, signal) {
      const body = { query, count, need_content: false };
      if (oriQuestion) body.ori_question = oriQuestion;
      const data = await post("/search", body, signal);
      return mapSearchResponse(data);
    },
    async fetchPage({ url }, signal) {
      const data = await post("/fetch", { url }, signal);
      return mapFetchResponse(data, url);
    },
  };
}
