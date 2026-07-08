// claude-retry-proxy — local HTTP retry proxy for Claude Code-compatible API providers.
//
// Streams responses back to the client. Retries transient HTTP errors (429, 500,
// 502, 503, 504) and network errors before a response body is streamed to the
// client. Retries aggressively with a uniform random jitter in [minDelayMs,
// maxDelayMs] (NOT slow exponential backoff) and a very high attempt ceiling,
// so the proxy keeps trying through provider-side rate-limit / availability
// windows until it succeeds (or hits the ceiling).
//
// IMPORTANT RETRY LIMITATION:
// The proxy can only retry BEFORE a response is streamed to Claude Code. Once the
// upstream starts streaming a response body and we begin writing bytes to the
// client, we are committed to that response. If the upstream disconnects halfway
// through a streaming response, the proxy CANNOT safely reconstruct and retry the
// partial response — the client already received part of it. In that case the
// connection is closed and Claude Code must retry the request itself.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// Config / argument parsing
// ---------------------------------------------------------------------------

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function parseArgs(argv) {
  const args = { config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') {
      args.config = argv[i + 1];
      i++;
    } else if (a.startsWith('--config=')) {
      args.config = a.slice('--config='.length);
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`claude-retry-proxy

Local HTTP retry proxy for Claude Code-compatible API providers.

Usage:
  node src/index.mjs --config ./config.local.json
  node src/index.mjs --config ~/path/to/config.json
  npm start                  # uses ./config.local.json
  npm run start:example      # uses ./config.example.json

Options:
  --config, -c <path>   Path to JSON config file. Supports ~ expansion.
  --help, -h            Show this help and exit.

Config fields:
  listenHost          Host to bind (default 127.0.0.1)
  port                Port to listen on (required, 1-65535)
  upstreamBaseUrl     Upstream provider base URL (required)
  maxAttempts         Total attempts including the first (>=1). Use a very high
                      value (e.g. 500000) to retry almost indefinitely.
  minDelayMs          Minimum retry delay (jitter range low end)
  maxDelayMs          Maximum retry delay (jitter range high end)
  retryStatuses       HTTP statuses that trigger a retry
  requestTimeoutMs    Per-attempt upstream request timeout
  logLevel            "debug" | "info" | "warn" | "error"
  logProgressEveryAttempts  Emit a progress log every N attempts (default 1000)
  logProgressIntervalMs     Emit a progress log at most every N ms (default 10000)
`);
}

function loadConfig(configPath) {
  if (!configPath) {
    console.error('Error: no config file provided. Use --config <path>.');
    console.error('Run with --help for usage.');
    process.exit(2);
  }
  const expanded = expandTilde(configPath);
  const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    console.error(`Error: could not read config file at ${abs}.`);
    console.error(`  ${e.message}`);
    console.error('Tip: copy config.example.json to config.local.json and edit it.');
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`Error: config file ${abs} is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  return cfg;
}

function validateConfig(cfg) {
  const errors = [];
  if (!cfg.upstreamBaseUrl || typeof cfg.upstreamBaseUrl !== 'string') {
    errors.push('upstreamBaseUrl is missing or not a string.');
  } else {
    try {
      const u = new URL(cfg.upstreamBaseUrl);
      if (!['http:', 'https:'].includes(u.protocol)) {
        errors.push(`upstreamBaseUrl must be http or https, got ${u.protocol}`);
      }
    } catch {
      errors.push(`upstreamBaseUrl is not a valid URL: ${cfg.upstreamBaseUrl}`);
    }
  }
  const maxAttempts = Number(cfg.maxAttempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    errors.push(`maxAttempts must be an integer >= 1, got ${JSON.stringify(cfg.maxAttempts)}.`);
  }
  // min/max delay define the random jitter range for retries (inclusive).
  // Backwards compat: if only legacy baseDelayMs/maxDelayMs are present, we
  // still accept them (base -> min, max -> max), but minDelayMs/maxDelayMs win.
  const minDelay = Number(cfg.minDelayMs ?? cfg.baseDelayMs ?? 1);
  const maxDelay = Number(cfg.maxDelayMs ?? cfg.maxDelayMs ?? 20);
  if (!Number.isFinite(minDelay) || minDelay < 0) {
    errors.push(`minDelayMs must be a number >= 0, got ${JSON.stringify(cfg.minDelayMs ?? cfg.baseDelayMs)}.`);
  }
  if (!Number.isFinite(maxDelay) || maxDelay < 0) {
    errors.push(`maxDelayMs must be a number >= 0, got ${JSON.stringify(cfg.maxDelayMs)}.`);
  }
  if (maxDelay < minDelay) {
    errors.push(`maxDelayMs (${maxDelay}) must be >= minDelayMs (${minDelay}).`);
  }
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`port must be an integer in [1, 65535], got ${JSON.stringify(cfg.port)}.`);
  }
  if (errors.length) {
    console.error('Config validation failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
}

function normalizeConfig(cfg) {
  const minDelay = Number(cfg.minDelayMs ?? cfg.baseDelayMs ?? 1);
  const maxDelay = Number(cfg.maxDelayMs ?? 20);
  return {
    listenHost: cfg.listenHost ?? '127.0.0.1',
    port: Number(cfg.port),
    upstreamBaseUrl: cfg.upstreamBaseUrl.replace(/\/+$/, ''), // strip trailing slashes
    maxAttempts: Number(cfg.maxAttempts),
    minDelayMs: minDelay,
    maxDelayMs: maxDelay,
    // Backwards-compat alias for old configs that used baseDelayMs.
    baseDelayMs: minDelay,
    retryStatuses: Array.isArray(cfg.retryStatuses)
      ? cfg.retryStatuses.map((s) => Number(s))
      : [429, 500, 502, 503, 504],
    requestTimeoutMs: Number(cfg.requestTimeoutMs ?? 600000),
    logLevel: cfg.logLevel ?? 'info',
    // How often (ms) to emit a progress line while a request is stuck retrying.
    logProgressIntervalMs: Number(cfg.logProgressIntervalMs ?? 10000),
    logProgressEveryAttempts: Number(cfg.logProgressEveryAttempts ?? 1000),
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'proxy-authorization']);

function createLogger(level) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const log = (lvl, msg, extra) => {
    if ((LEVELS[lvl] ?? LEVELS.info) < threshold) return;
    const ts = new Date().toISOString();
    let line = `${ts} [${lvl.toUpperCase()}] ${msg}`;
    if (extra && Object.keys(extra).length) {
      const safe = {};
      for (const [k, v] of Object.entries(extra)) safe[k] = v;
      try {
        line += ' ' + JSON.stringify(safe);
      } catch {
        // ignore non-serializable
      }
    }
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(line + '\n');
  };
  return {
    debug: (m, e) => log('debug', m, e),
    info: (m, e) => log('info', m, e),
    warn: (m, e) => log('warn', m, e),
    error: (m, e) => log('error', m, e),
  };
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' && v.length > 0 ? `<redacted len=${v.length}>` : '<redacted>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

// Retry delay is a uniform random jitter in [minDelayMs, maxDelayMs].
// We deliberately do NOT use slow exponential backoff: with a known upstream
// rate-limit/availability pattern, the goal is to retry aggressively but with
// randomized timing to avoid synchronized thundering-herd effects across many
// concurrent in-flight requests.
//
// `attempt` is accepted for API compatibility but not used — the delay range is
// constant across attempts, only the random value differs.
function backoffDelay(attempt, minDelayMs, maxDelayMs) {
  void attempt;
  if (maxDelayMs <= 0) return 0;
  const lo = Math.max(0, minDelayMs);
  const hi = Math.max(lo, maxDelayMs);
  // inclusive random in [lo, hi]
  return Math.round(lo + Math.random() * (hi - lo));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Header handling
// ---------------------------------------------------------------------------

// Hop-by-hop or unsafe-to-forward headers. These are removed before forwarding.
const STRIP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  // additional hop-by-hop headers (RFC 7230 6.1) that should not be forwarded
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function buildForwardHeaders(req, targetUrl) {
  const fwd = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (STRIP_HEADERS.has(key.toLowerCase())) continue;
    fwd[key] = val;
  }
  return fwd;
}

function parseRetryAfter(headerValue, now) {
  if (!headerValue) return null;
  const asNum = Number(headerValue);
  if (Number.isFinite(asNum) && asNum >= 0) {
    return Math.round(asNum * 1000); // seconds -> ms
  }
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - now);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Buffer request body
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, size)));
    req.on('error', (err) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    });
    req.on('aborted', () => {
      if (aborted) return;
      aborted = true;
      reject(new Error('client request aborted'));
    });
  });
}

// ---------------------------------------------------------------------------
// Upstream request
// ---------------------------------------------------------------------------

function makeUpstreamRequest({ method, targetUrl, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const reqOptions = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
    };

    const upstreamReq = lib.request(reqOptions, (upstreamRes) => {
      // We resolve immediately with the response object. The caller decides
      // whether to retry (based on status) BEFORE consuming/piping the body.
      resolve({ ok: true, res: upstreamRes });
    });

    upstreamReq.on('error', (err) => {
      resolve({ ok: false, error: err });
    });

    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy(new Error(`upstream request timeout after ${timeoutMs}ms`));
    });

    if (body && body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------

function buildTargetUrl(upstreamBaseUrl, incomingPath, query) {
  // upstreamBaseUrl already has trailing slashes stripped.
  // incomingPath always starts with '/'. Combine so base path is preserved.
  return `${upstreamBaseUrl}${incomingPath}${query ? `?${query}` : ''}`;
}

function sendJsonError(res, statusCode, message, retryInfo) {
  const body = JSON.stringify({
    error: {
      type: 'proxy_error',
      message,
      ...(retryInfo || {}),
    },
  });
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString(),
  };
  // set headers before writeHead
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.writeHead(statusCode);
  res.end(body);
}

async function handleProxy(req, res, cfg, logger) {
  const method = req.method;
  const incomingPath = req.url || '/';

  // Health check
  if (method === 'GET' && (incomingPath === '/health' || incomingPath === '/health/')) {
    const body = JSON.stringify({ ok: true });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(body).toString());
    res.writeHead(200);
    res.end(body);
    return;
  }

  // Split path and query
  const qIdx = incomingPath.indexOf('?');
  const pathOnly = qIdx === -1 ? incomingPath : incomingPath.slice(0, qIdx);
  const query = qIdx === -1 ? '' : incomingPath.slice(qIdx + 1);

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    logger.warn('failed to read client request body', { error: e.message });
    sendJsonError(res, 400, 'failed to read request body');
    return;
  }

  const forwardHeaders = buildForwardHeaders(req);

  let lastStatus = 0;
  let lastError = null;

  // Sparse progress logging: when a request is stuck retrying for a long time
  // (which is the whole point of maxAttempts=500000), we must NOT log every
  // attempt — that would write gigabytes of logs and saturate disk I/O. We emit
  // a progress line at most every logProgressEveryAttempts attempts AND at most
  // every logProgressIntervalMs wall-clock ms, whichever comes first.
  let lastProgressAttempt = 0;
  let lastProgressTime = Date.now();

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    const targetUrl = buildTargetUrl(cfg.upstreamBaseUrl, pathOnly, query);

    // Only log the full per-attempt request line on the first attempt; for
    // retries we rely on the sparse progress logger below to avoid log storms.
    if (attempt === 0) {
      logger.info('upstream request', {
        attempt: 1,
        of: cfg.maxAttempts,
        method,
        url: targetUrl,
        // redact sensitive headers in logs
        headers: redactHeaders(forwardHeaders),
      });
    }

    const result = await makeUpstreamRequest({
      method,
      targetUrl,
      headers: forwardHeaders,
      body,
      timeoutMs: cfg.requestTimeoutMs,
    });

    if (!result.ok) {
      // Network / request error -> retryable.
      lastStatus = 0;
      lastError = result.error;
    } else {
      const upstreamRes = result.res;
      lastStatus = upstreamRes.statusCode || 0;
      lastError = null;

      const isRetryable = cfg.retryStatuses.includes(lastStatus);

      if (!isRetryable) {
        // Success (or non-retryable error): stream the response back to client.
        // We are now committed — no more retries.
        if (attempt > 0) {
          logger.info('upstream success after retries', {
            attempt: attempt + 1,
            status: lastStatus,
            path: incomingPath,
          });
        }
        streamResponse(res, upstreamRes, logger);
        return;
      }

      // Retryable status. Consume + discard the body so the socket can be reused
      // and we can retry cleanly. We have NOT written anything to the client yet.
      await drainResponse(upstreamRes);
    }

    // ---- Retryable outcome (network error OR retryable status) ----
    const retryAfterMs =
      result.ok && result.res.headers['retry-after']
        ? parseRetryAfter(result.res.headers['retry-after'], Date.now())
        : null;

    if (attempt + 1 >= cfg.maxAttempts) {
      break;
    }

    // Sparse progress log. Emit on the first retry, then throttled by both
    // attempt-count and wall-clock-time thresholds (whichever triggers first).
    const now = Date.now();
    const byCount = attempt - lastProgressAttempt >= cfg.logProgressEveryAttempts;
    const byTime = now - lastProgressTime >= cfg.logProgressIntervalMs;
    if (attempt === 0 || byCount || byTime) {
      logger.warn('retrying upstream', {
        attempt: attempt + 1,
        of: cfg.maxAttempts,
        method,
        path: incomingPath,
        lastStatus,
        lastError: lastError?.message ?? null,
        retryAfterMs,
      });
      lastProgressAttempt = attempt;
      lastProgressTime = now;
    }

    // Delay: respect Retry-After if the upstream gave one (capped so a hostile
    // Retry-After can't stall us forever); otherwise a uniform random jitter in
    // [minDelayMs, maxDelayMs].
    const delay =
      retryAfterMs != null
        ? Math.min(retryAfterMs, Math.max(cfg.maxDelayMs, 1000) * 4)
        : backoffDelay(attempt, cfg.minDelayMs, cfg.maxDelayMs);

    if (delay > 0) {
      await sleep(delay);
    }
  }

  // All attempts failed.
  const message =
    lastError != null
      ? `all ${cfg.maxAttempts} attempts failed; last network error: ${lastError.message}`
      : `all ${cfg.maxAttempts} attempts failed; last upstream status: ${lastStatus}`;
  logger.error('all attempts exhausted', {
    method,
    path: incomingPath,
    lastStatus,
    lastError: lastError?.message,
  });
  const status = lastStatus >= 400 ? lastStatus : 502;
  sendJsonError(res, status, message, {
    attempts: cfg.maxAttempts,
    lastStatus,
    lastError: lastError?.message ?? null,
  });
}

function streamResponse(clientRes, upstreamRes, logger) {
  // Set response headers BEFORE writeHead.
  const passthroughHeaders = {};
  for (const [k, v] of Object.entries(upstreamRes.headers)) {
    if (STRIP_HEADERS.has(k.toLowerCase())) continue;
    passthroughHeaders[k] = v;
  }
  const status = upstreamRes.statusCode || 200;
  for (const [k, v] of Object.entries(passthroughHeaders)) clientRes.setHeader(k, v);
  clientRes.writeHead(status);

  // IMPORTANT RETRY LIMITATION: once we start piping, we are committed. If the
  // upstream disconnects mid-stream, we cannot retry — just end the response.
  upstreamRes.pipe(clientRes);

  upstreamRes.on('error', (err) => {
    logger.warn('error while streaming upstream response', { error: err.message });
    try {
      clientRes.end();
    } catch {
      // already closed
    }
  });
  clientRes.on('error', (err) => {
    logger.warn('client error while streaming', { error: err.message });
    try {
      upstreamRes.destroy();
    } catch {
      // ignore
    }
  });
}

function drainResponse(upstreamRes) {
  return new Promise((resolve) => {
    upstreamRes.resume();
    upstreamRes.on('end', resolve);
    upstreamRes.on('error', resolve);
  });
}

// ---------------------------------------------------------------------------
// Server bootstrap & graceful shutdown
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const rawCfg = loadConfig(args.config);
  validateConfig(rawCfg);
  const cfg = normalizeConfig(rawCfg);
  const logger = createLogger(cfg.logLevel);

  const server = http.createServer((req, res) => {
    handleProxy(req, res, cfg, logger).catch((err) => {
      logger.error('unhandled proxy error', { error: err.message, stack: err.stack });
      if (!res.headersSent) {
        sendJsonError(res, 500, `internal proxy error: ${err.message}`);
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`port ${cfg.port} is already in use`, { error: err.message });
    } else {
      logger.error('server error', { error: err.message });
    }
    process.exit(1);
  });

  server.listen(cfg.port, cfg.listenHost, () => {
    logger.info('claude-retry-proxy listening', {
      host: cfg.listenHost,
      port: cfg.port,
      upstream: cfg.upstreamBaseUrl,
      maxAttempts: cfg.maxAttempts,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('received signal, shutting down gracefully', { signal });
    server.close(() => {
      logger.info('server closed');
      process.exit(0);
    });
    // Force exit after 10s if connections hang.
    setTimeout(() => {
      logger.warn('forcing exit after shutdown timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
