# claude-retry-proxy

A small local HTTP **retry proxy** for Claude Code-compatible API providers.

When using coding agents with third-party API providers, especially providers that offer coding-plan or coding-agent model access, upstream capacity can be unstable. During busy periods, providers may frequently return transient errors such as **503 Service Unavailable** or **429 Too Many Requests**, which can interrupt long-running coding tasks.

Claude Code does have its own retry behavior, but that is not always enough for this use case. Its retry attempts may still all fail during provider-side congestion, and exponential backoff can become very slow after several failures, significantly reducing the speed of an automated workflow.

This repository provides a small local retry layer in front of your provider:

```text
Claude Code
  -> claude-retry-proxy
    -> your real upstream provider
```

Claude Code sends its API requests to this local proxy. The proxy forwards each request to your real upstream provider and automatically retries transient errors such as **429, 500, 502, 503, and 504**, plus network errors. Successful responses are streamed straight back to Claude Code.

It uses only Node.js built-in APIs — **no npm dependencies**, no `npm install`.

## What it does

* Runs as a local HTTP server, defaulting to `127.0.0.1:8787`.
* Forwards all paths, except `GET /health`, to `upstreamBaseUrl`, preserving the base path and query string.
* Retries configurable transient HTTP statuses and network errors aggressively, with a uniform random jitter in `[minDelayMs, maxDelayMs]` (not slow exponential backoff) and a very high attempt ceiling (default `500000`).
* Respects the upstream `Retry-After` header when present (capped so a hostile value cannot stall the proxy indefinitely).
* Uses **capped linear backoff + jitter**, not slow exponential backoff.
* Streams successful upstream responses back to the client.
* Redacts sensitive headers in logs:

  * `authorization`
  * `x-api-key`
  * `cookie`
  * `set-cookie`
  * `proxy-authorization`
* Supports graceful shutdown on `SIGINT` and `SIGTERM`.

## What it does NOT do

* It does **not** store API tokens. Your token stays in `~/.claude/settings.json`; the proxy simply forwards whatever `authorization` or `x-api-key` header Claude Code sends.
* It does **not** upload anything anywhere.
* It is not connected to GitHub or any external storage service.
* It does **not** retry a response that has already started streaming to Claude Code. See the important limitation below.

### Important retry limitation

The proxy can only retry **before** a response body is streamed to Claude Code. Once the upstream starts streaming a response and the proxy begins writing bytes to the client, the proxy is **committed** to that response.

If the upstream starts streaming and then disconnects halfway through, the proxy **cannot** safely reconstruct and retry the partial response, because the client has already received part of it. In that case, the connection is closed and Claude Code itself must retry the request.

Retries therefore cover these cases:

* The upstream returns a retryable HTTP status before sending a response body.
* The upstream connection fails outright because of a network error, timeout, or provider-side availability issue.

For long-running streaming requests, configure a generous `API_TIMEOUT_MS` so the provider has enough time to complete the response.

## Requirements

* **Node.js >= 18**

## Install

This project has no dependencies. Clone or copy the folder locally and you are ready to run it:

```bash
cd ~/claude-retry-proxy
node --version    # ensure >= 18
```

## Configure

Copy the example config to a local config, which is git-ignored, and edit it:

```bash
cp config.example.json config.local.json
# then edit config.local.json and set:
#   "upstreamBaseUrl": "https://your-real-provider.example.com/anthropic"
```

Config fields:

| Field              | Description                                                | Default / example                        |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------- |
| `listenHost`       | Host to bind                                               | `127.0.0.1`                              |
| `port`             | Port to listen on                                          | `8787`                                   |
| `upstreamBaseUrl`  | Real upstream provider base URL **required**               | `https://provider.example.com/anthropic` |
| `maxAttempts`      | Total attempts including the first attempt, must be `>= 1`. Use a very high value (e.g. `500000`) to retry almost indefinitely. | `500000` |
| `minDelayMs`       | Minimum retry delay (low end of the random jitter range)   | `1`                                      |
| `maxDelayMs`       | Maximum retry delay (high end of the random jitter range)  | `20`                                     |
| `retryStatuses`    | HTTP statuses that trigger a retry                         | `[429, 500, 502, 503, 504]`              |
| `requestTimeoutMs` | Per-attempt upstream request timeout                       | `1800000`                                |
| `logLevel`         | `debug`, `info`, `warn`, or `error`                        | `info`                                   |
| `logProgressEveryAttempts` | Emit a retry-progress log every N attempts (avoids log storms at high attempt counts) | `1000` |
| `logProgressIntervalMs`    | Emit a retry-progress log at most every N ms (wall-clock throttle) | `10000` |

### Retry behavior

The retry delay is a **uniform random value in `[minDelayMs, maxDelayMs]`** (e.g. a random 1–20 ms), constant across attempts. There is no exponential growth — the proxy retries aggressively and with randomized timing so that many concurrent in-flight requests do not synchronize into a thundering herd. `maxAttempts` defaults to `500000`, so a single request can keep retrying through a long provider-side outage before giving up.

Because a single request can now retry for a long time, the proxy uses **sparse progress logging**: it logs the first attempt, then a throttled progress line (at most every `logProgressEveryAttempts` attempts *and* every `logProgressIntervalMs` ms, whichever comes first), plus a line on success-after-retries and on final exhaustion. This prevents hundreds of thousands of retries from writing gigabytes of logs and saturating disk I/O.

### Base-path forwarding

The proxy concatenates `upstreamBaseUrl` and the incoming path, so the upstream base path is preserved. Trailing slashes on `upstreamBaseUrl` are stripped.

Example:

* `upstreamBaseUrl`: `https://provider.example.com/anthropic`
* incoming path: `/v1/messages`
* final upstream URL: `https://provider.example.com/anthropic/v1/messages`

## Start manually

Using your local config:

```bash
npm start
# or
node src/index.mjs --config ./config.local.json
```

Using the example config, only useful after replacing the placeholder upstream:

```bash
npm run start:example
```

## Start with tmux

Make the scripts executable once:

```bash
chmod +x scripts/start-tmux.sh scripts/stop-tmux.sh
```

Start in a detached tmux session named `claude-retry-proxy`. Logs are written to `retry-proxy.log`. The script uses `config.local.json` if present; otherwise, it falls back to the example config.

```bash
./scripts/start-tmux.sh
```

If the session already exists, the script does nothing.

Attach to the running session:

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

Point Claude Code at the local proxy by setting `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`.

Keep your real token in `~/.claude/settings.json`. Do **not** put it in this project.

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

Do **not** commit `config.local.json` or `~/.claude/settings.json`.

* `config.local.json` is listed in this project's `.gitignore`.
* `~/.claude/settings.json` lives outside this project and may contain private API credentials.

## Help

```bash
node src/index.mjs --help
```
