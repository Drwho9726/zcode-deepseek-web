# DeepSeek 联网搜索（ZCode 插件）

[English](README.md) | [简体中文](README_CN.md)

把 DSH（`deepseek-ai/deepseek-harness`）里的 DeepSeek 官方联网搜索/网页抓取移植到 ZCode。

插件直接调用 DeepSeek 官方 Search & Fetch API：

- `POST https://api.deepseek.com/v1/tools/search`
- `POST https://api.deepseek.com/v1/tools/fetch`

不经过额外的模型调用，按成功请求计费。搜索返回 DeepSeek 排序后的 `title / url / snippet / summary / date`，抓取返回标题和 Markdown 正文。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `mcp__deepseek_web__web_search` | 一次传 1–10 条 query，并发搜索、按 URL 去重合并，返回带 summary 的来源列表 |
| `mcp__deepseek_web__web_fetch` | 抓取指定 HTTP(S) URL，返回标题和 Markdown 正文 |

安装后，插件还会通过 `SessionStart` hook 在每个新会话注入一段简短说明，让 ZCode 里的模型在需要最新网页信息或读取 URL 时优先考虑这两个工具；skill 里还有更详细的查询策略和引用规则。

## 与 ZCode 原生搜索/抓取的关系

- 插件只增加 `web_search` / `web_fetch` 两个 MCP 工具，**不会禁用、替换或拦截** ZCode 原生的 WebSearch/WebFetch，也不会禁用模型自带的联网能力。
- DeepSeek 工具只是**优先选项**：正常联网任务先用它；如果搜索 0 结果、抓取 403/404、空正文、超时、401/402、429/5xx 重试后仍失败，模型会按 Hook/Skill 规则回退到原生工具或模型自带能力。
- 如果原生工具也不可用，模型会如实说明无法联网，不会编造来源。
- 你不需要在设置里关闭任何原生工具；本插件不会做这件事。

## 安装

1. 打开 **插件市场 → 添加 → 添加插件市场**，粘贴包含 `marketplace.json` 的市场根目录（本仓库为仓库根目录；克隆到别处就用你的实际路径）。
2. 在 **个人 → dev-e-plugins** 找到 **DeepSeek 联网搜索**，点击安装。
3. 打开插件详情 → **配置**，填写 DeepSeek API Key，点 **保存配置**。
4. 新建任务（建议新会话，确保 MCP server 和 hook 已加载）。

插件 ID：`deepseek-web@dev-e-plugins`（本地开发市场 ID；发布到其他市场时以该市场为准）

## API Key

两种方式，任选其一：

1. **插件设置（推荐给桌面用户）**：插件详情 → **配置** → `DeepSeek API Key`，点 **保存配置**。
   - 注意：ZCode 目前无法持久化 `sensitive` 字段，所以这个值会明文保存在 ZCode 的本地配置文件中。
   - 介意明文的话用方式 2。
2. **环境变量**：设置 `DEEPSEEK_API_KEY`，然后重启 ZCode。
   - 插件优先读取 `DEEPSEEK_WEB_API_KEY`（来自插件设置），为空时读取 `DEEPSEEK_API_KEY`。

Key 在 <https://platform.deepseek.com/api_keys> 创建。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `api_key` | 空 | DeepSeek API Key |
| `base_url` | `https://api.deepseek.com/v1/tools` | Search & Fetch API 基础地址 |
| `default_count` | `10` | 每个 query 的结果数，也是合并后的默认上限（1–50） |
| `max_summary_chars` | `800` | 每条结果返回给模型的 summary 上限（100–20000） |
| `requests_per_second` | `5` | 本插件实例的 Search/Fetch 限速（1–20） |
| `timeout_ms` | `30000` | 单次请求超时（1000–120000） |
| `fetch_max_chars` | `200000` | `web_fetch` 返回正文上限（1000–2000000） |

## 使用示例

- `帮我搜一下 DeepSeek V4 最近发布的消息，给出 3 个来源链接`
- `查一下 2026 年新能源汽车销量，优先官方或权威媒体`
- `读一下 https://api-docs.deepseek.com/guides/search 并总结 Search API 的参数`
- `对比这两个页面：https://example.com/a 和 https://example.com/b`

模型应该先调用 `web_search` 或 `web_fetch`，然后在回答里用 Markdown 链接引用实际使用的来源。

## 计费与限速

- Search：$0.75 / 1000 次成功请求
- Fetch：$0.75 / 1000 次成功请求
- `count` 不影响单价；空结果、失败、超时不计费
- Search QPS 100，Fetch QPS 25；插件默认 5 QPS，多 query 会自动排队

## 故障排查

**Settings → MCP 里看不到 `plugin:deepseek-web:deepseek_web`**

- 确认插件已安装并启用；
- 确认本机 `node` 可用（`node --version`）；
- 重启 ZCode 后查看 Settings → MCP 的状态和错误行。

**工具调用返回 401**

- Key 未配置或无效；在插件配置中重新填写，或设置 `DEEPSEEK_API_KEY` 后重启 ZCode。也可以直接改用原生联网工具。

**工具调用返回 429**

- 触发 DeepSeek 限流；等待后重试，或把 `requests_per_second` 调低；仍失败则改用原生联网工具。

**hook 没有生效**

- 插件启用后 hook 会自动运行；
- 新会话才会注入 SessionStart 上下文，旧会话不会。

**搜索结果为空**

- 换更具体或更短的 query；
- 尝试英文 query 或去掉过窄的 `site:` 限制；
- 仍为空则改用原生联网工具或模型自带能力。

## 安全说明

- 网页内容是不可信的外部数据；插件会在输出里附带提示，模型不应执行网页中的指令。
- 插件不读取或复制 DSH 的凭据；只使用你显式配置的 DeepSeek API Key。
- Key 只会作为 Bearer Token 发给你配置的 API 地址（默认 `api.deepseek.com`），插件日志不会打印 Key。
- 不建议把 Key 提交到版本控制；如需共享插件，请使用环境变量。

## 开源与发布

- 可发布的目录：本插件目录 `deepseek-web/`；如果希望别人直接添加本地市场，再附带上一级的 `marketplace.json`。
- **不要直接公开整个工作区**：`_inspect/`、`spike/`、日志、截图和本机配置不属于插件，可能包含个人信息。
- 无 npm 依赖，运行时只需要 Node 18+；ZCode 插件通过 `.zcode-plugin/plugin.json`、`.mcp.json` 和 `hooks/hooks.json` 加载。
- 作者：[Drwho9726](https://github.com/Drwho9726)。
- 本项目与 DeepSeek 官方无隶属关系；DeepSeek 是其权利人的商标。

## License

MIT，见 [LICENSE](./LICENSE)。

## 开发与烟测

```bash
# 协议 + tools/list
node scripts/smoke.mjs

# 缺 Key 错误路径
node scripts/smoke.mjs --missing-key

# 真实 API（Key 只从环境变量读取）
# PowerShell: $env:DEEPSEEK_API_KEY="sk-..."
node scripts/smoke.mjs --live
```

真实测试会调用一次 Search 和一次 Fetch，费用约 $0.0015。

## 设计说明

- 采用 DSH 的 `web-deepseek-api` 路线（原生 `/v1/tools`），不采用 `web-search-deepseek` 的 Anthropic `web_search_20250305` 服务端工具路线：后者会多一次模型调用。
- 搜索默认 `need_content: false`，只返回 summary；需要全文时用 `web_fetch`，与 DSH 的行为一致，节省上下文。
- 多 query 采用 round-robin 合并、URL 去重、总数截断；部分 query 失败时保留成功结果并附警告。
