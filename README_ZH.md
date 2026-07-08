# claude-retry-proxy

![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)
![Dependencies](https://img.shields.io/badge/dependencies-zero-success)

[English](README.md)

面向 Claude Code 兼容 API 提供商的本地 HTTP **重试代理**。

第三方 API 提供商（尤其是提供 Coding Plan 的厂商）上游服务器容量往往不稳定。高峰期会频繁返回各种因服务器繁忙/限流导致的错误，如 **503 Service Unavailable**、**429 Too Many Requests**，打断长时间运行的编程任务。

Claude Code 自带重试，但在此场景下并不够用：上游繁忙时前面几次重试可能全部失败，其重试采用的指数退避机制在连续失败后退避时间迅速变长，显著拖慢流程。

本仓库在提供商前面增加一层本地重试：

```text
Claude Code
  -> claude-retry-proxy
    -> 你的真实上游提供商
```

Claude Code 将请求发往本地代理，代理转发至真实上游提供商，并自动重试瞬时错误（**429、500、502、503、504**）及网络错误。成功响应原样流式回传给 Claude Code。

仅使用 Node.js 内置 API，**无 npm 依赖**，无需 `npm install`。

## 功能

* 以本地 HTTP 服务器形式运行，默认监听 `127.0.0.1:8787`。
* 除 `GET /health` 外，所有路径转发至 `upstreamBaseUrl`，保留基础路径与查询字符串。
* 激进重试可配置的瞬时状态码与网络错误，采用 `[minDelayMs, maxDelayMs]` 区间内的均匀随机抖动（非指数退避），尝试次数上限极高（默认 `500000`）。
* 遵循上游 `Retry-After` 头，并设上限，防止恶意值导致代理无限阻塞。
* 采用**有上限的线性退避 + 抖动**，而非缓慢的指数退避。
* 上游成功响应原样流式回传客户端。
* 日志中对以下敏感头脱敏：

  * `authorization`
  * `x-api-key`
  * `cookie`
  * `set-cookie`
  * `proxy-authorization`
* 支持 `SIGINT`、`SIGTERM` 优雅关闭。

## 无任何恶意行为，可审查

* **不**存储 API token。token 留在 `~/.claude/settings.json`，代理只转发 Claude Code 发来的 `authorization` 或 `x-api-key` 头。
* **不**向任何地方上传任何数据。
* 不连接 GitHub 或任何外部存储。
* **不**重试已开始流式回传的响应。详见下方限制。

### 重试限制

代理仅在响应体开始流式回传给 Claude Code **之前**重试。一旦上游开始返回响应、代理开始向客户端写数据，即已提交该响应，无法回退。

若上游在流式返回过程中断开，代理**无法**安全重建并重试这一不完整响应——客户端已收到部分数据。此时连接关闭，由 Claude Code 自行重试。

因此重试覆盖以下两类情形：

* 上游在发送响应体之前返回可重试状态码。
* 上游连接因网络错误、超时或提供商侧可用性问题而失败。

长时流式请求请配置较宽裕的 `API_TIMEOUT_MS`，给提供商足够时间完成响应。

## 环境要求

* **Node.js >= 18**

## 安装

无依赖。克隆或复制目录即可运行：

```bash
cd ~/claude-retry-proxy
node --version    # 确认 >= 18
```

## 配置

复制示例配置为本地配置（已被 git 忽略）后编辑：

```bash
cp config.example.json config.local.json
# 编辑 config.local.json，设置：
#   "upstreamBaseUrl": "https://your-real-provider.example.com/anthropic"
```

配置字段：

| 字段              | 描述                                                       | 默认 / 示例                              |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------- |
| `listenHost`       | 绑定主机                                                   | `127.0.0.1`                              |
| `port`             | 监听端口                                                   | `8787`                                   |
| `upstreamBaseUrl`  | 真实上游基础 URL，**必填**                                 | `https://provider.example.com/anthropic` |
| `maxAttempts`      | 含首次在内的总尝试次数，须 `>= 1`。设较大值（如 `500000`）可近乎无限重试。 | `500000` |
| `minDelayMs`       | 最小重试延迟（抖动区间下限）                               | `1`                                      |
| `maxDelayMs`       | 最大重试延迟（抖动区间上限）                               | `20`                                     |
| `retryStatuses`    | 触发重试的 HTTP 状态码                                     | `[429, 500, 502, 503, 504]`              |
| `requestTimeoutMs` | 单次上游请求超时                                           | `1800000`                                |
| `logLevel`         | `debug`、`info`、`warn` 或 `error`                         | `info`                                   |
| `logProgressEveryAttempts` | 每隔 N 次尝试输出一条重试进度日志，避免高次数下日志风暴 | `1000` |
| `logProgressIntervalMs`    | 至多每隔 N 毫秒输出一条进度日志，按墙钟时间节流        | `10000` |

### 重试行为

重试延迟取 `[minDelayMs, maxDelayMs]` 区间内的均匀随机值（如 1–20 ms 随机值），各次尝试保持不变，无指数增长。如此以激进、随机化的间隔重试，避免大量并发在途请求同步形成惊群。`maxAttempts` 默认 `500000`，单个请求可在长时间上游中断中持续重试，直到成功或耗尽。

单个请求可能重试很久，因此代理采用**稀疏进度日志**：首次尝试记录一条，之后按节流输出进度行（至多每 `logProgressEveryAttempts` 次尝试**且**每 `logProgressIntervalMs` 毫秒一条，以先到者为准），并在"重试后成功"和"最终耗尽"时各记一条。避免数十万次重试写出数 GB 日志、拖垮磁盘 I/O。

### 基础路径转发

代理拼接 `upstreamBaseUrl` 与入站路径，保留上游基础路径；`upstreamBaseUrl` 末尾的斜杠会被去除。

示例：

* `upstreamBaseUrl`：`https://provider.example.com/anthropic`
* 入站路径：`/v1/messages`
* 最终上游 URL：`https://provider.example.com/anthropic/v1/messages`

## 手动启动

使用本地配置：

```bash
npm start
# 或
node src/index.mjs --config ./config.local.json
```

使用示例配置（替换占位上游后方有意义）：

```bash
npm run start:example
```

## 以 tmux 启动

先为脚本添加可执行权限：

```bash
chmod +x scripts/start-tmux.sh scripts/stop-tmux.sh
```

在名为 `claude-retry-proxy` 的分离 tmux 会话中启动，日志写入 `retry-proxy.log`。脚本优先使用 `config.local.json`，不存在则回退到示例配置。

```bash
./scripts/start-tmux.sh
```

会话已存在时脚本不做任何操作。

接入运行中的会话：

```bash
tmux attach -t claude-retry-proxy
```

停止：

```bash
./scripts/stop-tmux.sh
```

## 健康检查

代理运行时：

```bash
curl http://127.0.0.1:8787/health
# -> { "ok": true }
```

## 配置 Claude Code

在 `~/.claude/settings.json` 中设置 `ANTHROPIC_BASE_URL`，使 Claude Code 指向本地代理。

真实 token 放在 `~/.claude/settings.json`，**不要**放入本项目。

`~/.claude/settings.json` 示例片段：

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

编辑后重启 Claude Code，使其加载新的环境变量。

## 帮助

```bash
node src/index.mjs --help
```
