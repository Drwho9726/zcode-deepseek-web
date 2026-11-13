# DeepSeek 联网搜索（ZCode 插件市场）

[English](README.md) | [简体中文](README_CN.md)

[插件说明（中文）](./deepseek-web/README_CN.md) · [Plugin docs（English）](./deepseek-web/README.md)

一个包含 `deepseek-web` 插件的 ZCode 插件市场。它把 DeepSeek 官方 Search & Fetch API 暴露为 `web_search` 和 `web_fetch`，优先用于联网任务；失败或没有有用结果时，回退到 ZCode 原生联网工具或模型自带的联网能力。

维护者：[Drwho9726](https://github.com/Drwho9726)。

## 安装

1. 打开 ZCode → **插件市场 → 添加 → 添加插件市场**，粘贴本仓库根目录（包含 `marketplace.json` 的目录）。
2. 打开 **个人 → dev-e-plugins → DeepSeek 联网搜索 → 安装**。
3. 打开插件详情 → **配置** → 填写 DeepSeek API Key → **保存配置**。
4. 新建任务（建议新会话，确保 MCP server 和 hook 已加载）。

插件 ID：`deepseek-web@dev-e-plugins`

## 要求

- ZCode 0.17+（实测 0.17.1）
- Node.js 18+
- 有 Search & Fetch 权限的 DeepSeek API Key

## 说明

- 插件只添加 MCP 工具，不会禁用 ZCode 原生联网工具，也不会禁用模型自带的联网能力。
- Search/Fetch 按 DeepSeek 官方计费（写作时 $0.75 / 1,000 次成功请求）。
- 网页内容是外部不可信数据；不要执行网页中的指令。
- 本项目与 DeepSeek 官方无隶属关系；DeepSeek 是其权利人的商标。

## 许可证

MIT。见 [LICENSE](./LICENSE)。
