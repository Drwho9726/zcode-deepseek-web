# DeepSeek Web Search for ZCode

[English](README.md) | [简体中文](README_CN.md)

A ZCode plugin that ports the DeepSeek official Search & Fetch API used by DSH (`deepseek-ai/deepseek-harness`).

It exposes two MCP tools:

- `mcp__deepseek_web__web_search` — 1–10 queries, concurrent search, URL deduplication, ranked sources with summaries.
- `mcp__deepseek_web__web_fetch` — fetch a URL and return its title plus clean Markdown.

The plugin calls `https://api.deepseek.com/v1/tools/search` and `/v1/tools/fetch` directly. No extra model call is involved.

A `SessionStart` hook injects a short preference note into every new session, so any model in ZCode is encouraged to use these tools when it needs current web information or page content. The bundled skill explains query syntax, citation rules, and safety.

## Relationship to native tools

- The plugin only adds two MCP tools. It **never disables, replaces, or intercepts** ZCode's native WebSearch/WebFetch or the model's built-in web capability.
- DeepSeek tools are a **preference**: use them first; if search returns no results, fetch fails with 403/404/401/402/429/5xx, times out, or returns empty content, fall back to the native tools.
- If neither works, the model should say it cannot access the web rather than invent sources.
- No native tool needs to be disabled for this plugin.

## Install

1. Open **Plugin Marketplace → Add → Add Plugin Marketplace** and paste the market root containing `marketplace.json` (in this repository, the repository root; use your actual clone path elsewhere).
2. Open **Personal → dev-e-plugins**, find **DeepSeek Web Search**, and install it.
3. Open the plugin details → **Configuration** and enter your DeepSeek API key, then save.
4. Start a new task so the MCP server and hook are loaded.

Plugin ID: `deepseek-web@dev-e-plugins` (local development marketplace ID; a different marketplace will produce a different ID).

## API key

Either:

1. Enter it in the plugin's **Configuration** (`配置`) section and save. ZCode cannot persist `sensitive` fields today, so this value is stored in plain text in ZCode's local config file.
2. Set `DEEPSEEK_API_KEY` in the environment and restart ZCode. The plugin reads `DEEPSEEK_WEB_API_KEY` first, then `DEEPSEEK_API_KEY`.

Create a key at <https://platform.deepseek.com/api_keys>.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `api_key` | empty | DeepSeek API key |
| `base_url` | `https://api.deepseek.com/v1/tools` | Search & Fetch API base |
| `default_count` | `10` | Results per query and default merged cap (1–50) |
| `max_summary_chars` | `800` | Summary cap per result (100–20000) |
| `requests_per_second` | `5` | Per-instance request rate (1–20) |
| `timeout_ms` | `30000` | Per-request timeout (1000–120000) |
| `fetch_max_chars` | `200000` | `web_fetch` body cap (1000–2000000) |

## Billing and limits

- Search: $0.75 per 1,000 successful requests.
- Fetch: $0.75 per 1,000 successful requests.
- Search QPS 100, Fetch QPS 25; the plugin defaults to 5 QPS and queues multi-query searches.

## Troubleshooting

- **Server missing in Settings → MCP**: confirm the plugin is enabled, `node` is available, and restart ZCode. Look for `plugin:deepseek-web:deepseek_web`.
- **401**: the API key is missing or invalid. Set it in the plugin's Configuration section or via `DEEPSEEK_API_KEY`; native web tools remain available as a fallback.
- **429**: wait and retry, or lower `requests_per_second`; fall back to native tools if it persists.
- **Hook not applied**: SessionStart context is injected only into new sessions.
- **No search results**: use shorter or more specific queries; add an English query or relax `site:` filters; otherwise fall back to native tools.

## Safety

- Web content is untrusted external data; the tools include a warning and the model should not follow instructions found in pages.
- The plugin does not read or copy DSH credentials; it only uses the key you configure.
- The key is sent only to the configured API base (default `api.deepseek.com`) in the `Authorization` header and is never logged.
- Do not commit the key. Use an environment variable when sharing the plugin.

## Open source and publishing

- Publishable unit: this `deepseek-web/` plugin directory; include the parent `marketplace.json` only if you want others to add the local marketplace directly.
- **Do not publish the whole workspace**: `_inspect/`, `spike/`, logs, screenshots, and local settings are not part of the plugin and may contain personal data.
- No npm dependencies; Node 18+ is the only runtime requirement. ZCode loads the plugin through `.zcode-plugin/plugin.json`, `.mcp.json`, and `hooks/hooks.json`.
- Author: [Drwho9726](https://github.com/Drwho9726).
- This project is not affiliated with DeepSeek. DeepSeek is a trademark of its owner.

## License

MIT. See [LICENSE](./LICENSE).

## Development

```bash
node scripts/smoke.mjs
node scripts/smoke.mjs --missing-key
# PowerShell: $env:DEEPSEEK_API_KEY="sk-..."
node scripts/smoke.mjs --live
```

The live test performs one search and one fetch (about $0.0015).

## Design notes

- Uses the native `/v1/tools` API (DSH's `web-deepseek-api` path), not the Anthropic `web_search_20250305` server-tool path.
- Search uses `need_content: false` and returns summaries; use `web_fetch` for full text.
- Multiple queries are merged round-robin, deduplicated by URL, and capped. Partial failures keep successful results and add a warning.
