#!/usr/bin/env bash
# Stop the "claude-retry-proxy" tmux session if it exists.
set -euo pipefail

SESSION="claude-retry-proxy"

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux is not installed or not on PATH." >&2
  exit 1
fi

if tmux has-session -t "${SESSION}" 2>/dev/null; then
  echo "Stopping tmux session '${SESSION}'..."
  tmux kill-session -t "${SESSION}"
  echo "Stopped."
else
  echo "No tmux session named '${SESSION}' is running."
fi
