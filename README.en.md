<p align="center">
  <a href="README.md">简体中文</a> | <b>English</b>
</p>

# cc-proxy

A local transparent proxy for Claude Code: it lets sessions that talk directly to
the Anthropic API or any third-party gateway display deep-thinking output as
`> 💭 Thinking` dim blockquotes, streamed line by line (ported from agy-cc-proxy).

![Thinking rendering effect](docs/screenshot-thinking.png)

## Installation

Requirements:

- Node.js >= 18
- Claude Code CLI installed (`claude` available on your PATH)

```bash
git clone <repo-url> cc-proxy && cd cc-proxy
npm link          # registers the claude-proxy / cc-proxy commands on your global PATH
```

Verify:

```bash
claude-proxy --version    # prints the proxy's own version, e.g. claude-proxy 1.0.0
```

Updating:

Installation is via `npm link` (symlinked to this repo directory), so updates
take effect right after pulling the code — no re-registration needed:

```bash
cd cc-proxy
git pull          # pull the latest code, effective immediately
```

> If an upstream release changes the package structure, run `npm link` once more
> afterward as a safety net.

Uninstall:

```bash
npm unlink -g cc-proxy
```

> Prefer not to install globally? Run `node bin/claude-proxy.js` instead — same behavior.

## Usage

```bash
cc-proxy                    # start the proxy and enter interactive Claude Code
claude-proxy                # equivalent command
cc-proxy -v                 # print the proxy version and exit
cc-proxy -c                 # arguments pass through to claude (--continue here)
cc-proxy -p "explain this"  # non-interactive mode works too
```

What the command does:

1. Starts a local transparent proxy on 127.0.0.1 (random free port)
2. Spawns `claude` with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` injected (all args/stdio passed through)
3. Shuts the proxy down when claude exits (exit code passed through) and prints a
   per-session usage summary to stderr (requests / input / output / cache tokens;
   requires `CC_PROXY_LOG=1`)

### Choosing an upstream

The proxy forwards to the `ANTHROPIC_BASE_URL` present **when it starts**; if unset
it uses the official `https://api.anthropic.com`.

```bash
# Official API
cc-proxy

# Third-party gateway (the base URL path prefix is prepended as-is)
ANTHROPIC_BASE_URL=https://gw.example.com/api cc-proxy
```

> The variable is saved as the forwarding target first, then replaced with the local
> address for claude, so your existing configuration is not lost.

### Rendering

Applies only when the client UA matches `claude-cli` / `claude-code`; thinking blocks
are rewritten to:

```
💭 Thinking
line-by-line reasoning (dimmed)
```

Other clients (curl, language SDKs, etc.) pass through untouched.

In multi-turn conversations, already-rendered thinking text in the message history is
stripped before forwarding, so the context does not keep growing.

### Settings page

```bash
cc-proxy --setting
```

Opens an interactive settings page showing the active configuration (persisted
to `~/.cc-proxy/config.json`) and its path. Press `1` to toggle the Suggestion
Mode forwarding switch (see below); Enter/Esc exits without changes. A missing
or corrupted config file falls back to defaults without affecting startup.

### Suggestion Mode

Claude Code sends extra `[SUGGESTION MODE`-prefixed input-suggestion requests
outside the main conversation (extra token cost). By default this proxy
**intercepts** them and returns a structurally complete empty response
(streaming/non-streaming adaptive); the main conversation is unaffected and
`usage.json` / debug logs see zero increase. Non-Claude-Code clients are
unaffected.

Press `1` in the settings page to toggle forwarding (written to disk
immediately): the terminal prints
`Settings saved: Suggestion Mode forwarding → on/off (…)` and exits
automatically. Enter/Esc exits without changes.

```
[1] Suggestion Mode 输入建议转发: 关（拦截建议请求，返回空响应）

设置已保存：Suggestion Mode 输入建议转发 → 开（转发上游，可能产生额外计费）
已退出。
```

(The settings page output is in Chinese; the lines above read: `[1] Suggestion
Mode forwarding: off (intercept, return empty response)` / `Settings saved:
Suggestion Mode forwarding → on (forward upstream, may incur extra cost)` /
`Exited.`)

When enabled, suggestion requests are forwarded upstream
(Claude Code shows input suggestions, at extra cost). The switch persists as
`forwardSuggestionMode` in `~/.cc-proxy/config.json`. The change takes effect on
the **next session start** (the running proxy reads the config once at startup).

### Usage tracking

The proxy automatically extracts token usage from responses (SSE
`message_start`/`message_delta` or non-streaming JSON) and persists daily
totals to `~/.cc-proxy/usage.json`:

```json
{
  "2026-10-07": {
    "requests": 42,
    "inputTokens": 123456,
    "outputTokens": 5678,
    "cacheReadTokens": 89012,
    "cacheCreationTokens": 1234
  }
}
```

A missing or corrupted file falls back to empty stats; write failures never
block proxy traffic. When `claude` exits, the day's totals are printed to
stderr (requires `CC_PROXY_LOG=1`).

### Debug request log

```bash
CC_PROXY_DEBUG=1 cc-proxy
```

With `CC_PROXY_DEBUG=1`, each request's method/url/status/duration, request
body, and SSE event stream are written to `~/.cc-proxy/logs/` (one `.log`
file per request) — useful for troubleshooting third-party gateway
compatibility:

- Headers record names only; values (authorization, API keys, etc.) are never written
- Write failures are silently dropped and never affect proxy traffic
- When unset: zero overhead, zero files

## Development

```bash
npm test        # node:test unit + end-to-end tests (75 cases)
```

## Layout

| Path | Purpose |
|---|---|
| `bin/claude-proxy.js` | CLI entry: --version / --setting / start proxy → inject env → spawn claude |
| `bin/settings-cli.js` | `--setting` interactive settings page: keypress assembly + menu loop |
| `src/thinking-text.js` | Rendering core: formatting, streaming rewrite, history strip, UA gate |
| `src/proxy.js` | HTTP proxy and response rewriting (SSE / non-streaming JSON), Suggestion Mode intercept, usage/debug hooks |
| `src/upstream.js` | Upstream URL resolution and request forwarding |
| `src/settings.js` | Config read/write (`~/.cc-proxy/config.json`), missing/corrupt falls back to defaults |
| `src/suggestion-mode.js` | Suggestion request detection and empty-response building (streaming/non-streaming) |
| `src/usage.js` | Usage extraction and daily persistence (`~/.cc-proxy/usage.json`) |
| `src/debug-log.js` | Per-request debug log (`CC_PROXY_DEBUG=1`) |
| `test/*.test.mjs` | Unit and end-to-end tests (node:test) |
