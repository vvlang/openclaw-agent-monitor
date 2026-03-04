#!/bin/bash
# OpenClaw Agent 监控：后台运行 writer，前台运行静态服务；收到 SIGTERM 时停止 writer。
cd "$(dirname "$0")"

WRITER_PID=""
cleanup() {
  [ -n "$WRITER_PID" ] && kill "$WRITER_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT

node agent-status-writer.js &
WRITER_PID=$!
sleep 1
npx -y serve -p 3880 --no-clipboard
