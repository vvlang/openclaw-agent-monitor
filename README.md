# OpenClaw Agent 监控

OpenClaw 全量 Agent 状态与会话内容可视化监控，数据来自 `openclaw status --json`。

## 文件说明

| 文件 | 说明 |
|------|------|
| `agent-status-writer.js` | 状态写入器：轮询 openclaw status --json，采集 Agent / Gateway / 系统信息 / 会话内容预览，写入 `agent-status.json` |
| `agent-dashboard.html` | 仪表盘：Agent 卡片、Gateway、系统信息（CPU/内存/磁盘/IP/网络）、状态变化日志、最近会话、会话内容预览 |
| `log-tailer.js` | 可选：监听单个 session 的 .jsonl 做实时状态（单 Agent 场景） |
| `STATUS_ANALYSIS.md` | 目录与数据源分析说明 |

## 依赖

- Node.js
- 本机已安装并配置 OpenClaw，可执行 `openclaw status --json`

## 使用

1. 启动写入器（在仓库目录下）：
   ```bash
   node agent-status-writer.js
   ```

2. 用本地静态服务打开仪表盘（避免 file:// 跨域）：
   ```bash
   npx -y serve -p 3880
   ```
   浏览器打开：<http://localhost:3880/agent-dashboard.html>

## 说明

- `agent-status.json` 由 writer 生成，已加入 `.gitignore`，不会提交到仓库。
- 仪表盘会显示本机系统信息（CPU、内存、磁盘、IP、网络），数据仅在本地使用。
