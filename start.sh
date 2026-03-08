#!/bin/bash
# OpenClaw Agent 监控：writer 同时提供状态写入与 HTTP 服务（仪表盘 + 交互式记忆 API）
cd "$(dirname "$0")"

node agent-status-writer.js
