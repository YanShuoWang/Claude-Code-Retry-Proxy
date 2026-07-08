#!/usr/bin/env bash
# Start claude-retry-proxy inside a tmux session named "claude-retry-proxy".
# Does nothing if the session already exists. Logs to retry-proxy.log.
set -euo pipefail

SESSION="claude-retry-proxy"
# Resolve project root as the directory containing this script's parent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${PROJECT_DIR}/retry-proxy.log"

# Check tmux is available.
if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux is not installed or not on PATH." >&2
  exit 1
fi

# Do nothing if the session already exists.
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  echo "tmux session '${SESSION}' already exists. Not starting a new one."
  echo "Attach with: tmux attach -t ${SESSION}"
  exit 0
fi

cd "${PROJECT_DIR}"

# Prefer config.local.json if it exists, else fall back to the example config.
if [ -f "${PROJECT_DIR}/config.local.json" ]; then
  CONFIG_ARG="--config ./config.local.json"
else
  CONFIG_ARG="--config ./config.example.json"
fi

echo "Starting claude-retry-proxy in tmux session '${SESSION}'..."
echo "Log file: ${LOG_FILE}"

tmux new-session -d -s "${SESSION}" -c "${PROJECT_DIR}" \
  "node src/index.mjs ${CONFIG_ARG} 2>&1 | tee -a ${LOG_FILE}"

echo "Started. Attach with: tmux attach -t ${SESSION}"
