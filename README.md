# claude-retry-proxy

A small local HTTP **retry proxy** for Claude Code-compatible API providers.

Claude Code sends its API requests to this local proxy. The proxy forwards each
request to your real upstream provider and automatically retries transient errors
such as **429, 500, 502, 503, and 504**, plus network errors. Successful
responses are streamed straight back to Claude Code.

It uses only Node.js built-in APIs — **no npm dependencies**, no `npm install`.

## What it does

- Runs as a local HTTP server (default `127.0.0.1:8787`).
- Forwards all paths (except `GET /health`) to `upstreamBaseUrl`, preserving the
  base path and query string.
- Retries configurable transient HTTP statuses and network errors.
- Respects the upstream `Retry-After` header when present.
- Uses **capped linear backoff + jitter** (not slow exponential backoff).
- Streams successful upstream responses back to the client.
- Redacts sensitive headers (`authorization`, `x-api-key`, `cookie`,
  `set-cookie`, `proxy-authorization`) in logs.
- Graceful shutdown on `SIGINT` / `SIGTERM`.

## What it does NOT do

- It does **not** store API tokens. Your token stays in
  `~/.claude/settings.json`; the proxy forwards whatever `authorization` /
  `x-api-key` header Claude Code sends.
- It does **not** upload anything anywhere and is not connected to GitHub.
- It does **not** retry a response that has already started streaming to
  Claude Code (see the important limitation below).

### Important retry limitation

The proxy can only retry **before** a response body is streamed to Claude Code.
Once the upstream starts streaming a response and the proxy begins writing bytes
to the client, the proxy is **committed** to that response.

If the upstream starts streaming and then disconnects halfway through, the
proxy **cannot** safely reconstruct and retry the partial response — the client
already received part of it. In that case the connection is closed and Claude
Code itself must retry the request. Retries therefore cover the cases where the
upstream returns a retryable status *before* sending a body, or where the
upstream connection fails outright (network/timeout errors). For long-running
streaming requests, configure a generous `API_TIMEOUT_MS` upstream so the
provider has room to complete the response.

## Requirements

- **Node.js >= 18**

## Install

This project has no dependencies. Clone or copy the folder locally and you are
ready to run it:

```bash
cd ~/claude-retry-proxy
node --version    # ensure >= 18
```

## Configure

Copy the example config to a local config (which is git-ignored) and edit it:

```bash
cp config.example.json config.local.json
# then edit config.local.json and set:
#   "upstreamBaseUrl": "https://your-real-provider.example.com/anthropic"
```

Config fields:

| Field              | Description                                                    | Default / example                       |
|--------------------|----------------------------------------------------------------|-----------------------------------------|
| `listenHost`       | Host to bind                                                   | `127.0.0.1`                             |
| `port`             | Port to listen on                                              | `8787`                                  |
| `upstreamBaseUrl`  | Real upstream provider base URL **(required)**                | `https://provider.example.com/anthropic`|
| `maxAttempts`      | Total attempts including the first (`>= 1`)                    | `15`                                    |
| `baseDelayMs`      | Base delay for backoff                                         | `2000`                                  |
| `maxDelayMs`       | Cap for backoff delay                                          | `15000`                                 |
| `retryStatuses`    | HTTP statuses that trigger a retry                             | `[429, 500, 502, 503, 504]`             |
| `requestTimeoutMs` | Per-attempt upstream request timeout                           | `1800000`                               |
| `logLevel`         | `debug` \| `info` \| `warn` \| `error`                        | `info`                                  |

### Base-path forwarding

The proxy concatenates `upstreamBaseUrl` + incoming path, so the upstream base
path is preserved. Trailing slashes on `upstreamBaseUrl` are stripped.

- `upstreamBaseUrl`: `https://provider.example.com/anthropic`
- incoming path: `/v1/messages`
- final upstream URL: `https://provider.example.com/anthropic/v1/messages`

## Start manually

Using your local config:

```bash
npm start
# or
node src/index.mjs --config ./config.local.json
```

Using the example config (only useful if you replace the placeholder upstream):

```bash
npm run start:example
```

## Start with tmux

Make the scripts executable once:

```bash
chmod +x scripts/start-tmux.sh scripts/stop-tmux.sh
```

Start in a detached tmux session named `claude-retry-proxy` (logs to
`retry-proxy.log`, and uses `config.local.json` if present, otherwise the
example config):

```bash
./scripts/start-tmux.sh
```

If the session already exists, the script does nothing. Attach with:

```bash
tmux attach -t claude-retry-proxy
```

Stop it:

```bash
./scripts/stop-tmux.sh
```

## Health check

While the proxy is running:

```bash
curl http://127.0.0.1:8787/health
# -> { "ok": true }
```

## Configure Claude Code

Point Claude Code at the local proxy by setting `ANTHROPIC_BASE_URL` in
`~/.claude/settings.json`. **Keep your real token in
`~/.claude/settings.json`** — do not put it in this project.

Example `~/.claude/settings.json` snippet:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_REAL_TOKEN",
    "API_TIMEOUT_MS": "1800000",
    "API_FORCE_IDLE_TIMEOUT": "0"
  }
}
```

After editing, restart Claude Code so it picks up the new environment.

> Do **not** commit `config.local.json` or `~/.claude/settings.json`. They are
> both git-ignored where relevant (`config.local.json` is listed in this
> project's `.gitignore`; `~/.claude/settings.json` lives outside this project
> entirely).

## Help

```bash
node src/index.mjs --help
```
