#!/bin/bash
# OpenClaw Agent 监控：writer 同时提供状态写入与 HTTP 服务（仪表盘 + 交互式记忆 API）
cd "$(dirname "$0")"

# 当 OPENCLAW_GATEWAY_URL 为 http://localhost:18789 时，CLI 会报 SECURITY ERROR，需允许私有明文 WS
export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1

node agent-status-writer.js
