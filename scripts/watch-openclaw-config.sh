#!/usr/bin/env bash
# 监控哪些进程在访问/修改 OpenClaw 配置文件（~/.openclaw/openclaw.json、clawdbot.json）
# 用法: sudo ./scripts/watch-openclaw-config.sh
# 需要 root 以便 fs_usage 能捕获所有进程的文件操作

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
CONFIG1="$OPENCLAW_DIR/openclaw.json"
CONFIG2="$OPENCLAW_DIR/clawdbot.json"

echo "监控目录: $OPENCLAW_DIR"
echo "配置文件: $CONFIG1, $CONFIG2"
echo "按 Ctrl+C 停止"
echo "---"

# macOS: fs_usage 可看到所有进程对文件的 open/read/write
if command -v fs_usage &>/dev/null; then
  # -f path 限制只显示匹配路径的活动，减少噪音
  sudo fs_usage -w -f filesys 2>/dev/null | grep --line-buffered -E "openclaw\.json|clawdbot\.json"
else
  echo "未找到 fs_usage（仅 macOS 可用）。可用 lsof 定期采样："
  while true; do
    echo "--- $(date '+%H:%M:%S') ---"
    lsof 2>/dev/null "$CONFIG1" "$CONFIG2" || true
    sleep 5
  fi
fi
