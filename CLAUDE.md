# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                          # 全量测试（node:test）
node --test "test/thinking-text.test.mjs"         # 运行单个测试文件
node --test --test-name-pattern="历史剥离" test/thinking-text.test.mjs  # 按名称过滤
node bin/claude-proxy.js                          # 不经 npm link 直接运行 CLI
```

环境要求 Node.js ≥ 18（ESM，零运行时依赖，仅用 `node:http`/`node:https`/`child_process` 等）。无 lint / build 步骤。

已知环境问题：Node 25.x 下 `npm test` 会以 `--test-concurrency=0` 挂起；此时改用 `node --test --test-timeout=15000 "test/"*.test.mjs`。

## Architecture

cc-proxy 是 Claude Code 的本地透明代理（Anthropic Messages API in → 上游转发 out），核心链路：

```
bin/claude-proxy.js   CLI 入口：--version / --setting / 起代理 → 注入 env → spawn claude
        │
src/proxy.js          HTTP 代理核心：请求/响应改写、SSE 事件级处理
  ├─ src/upstream.js          上游地址解析（ANTHROPIC_BASE_URL 或官方 API）与转发
  ├─ src/thinking-text.js     thinking→text 流式改写（核心特性）
  ├─ src/suggestion-mode.js   [SUGGESTION MODE 请求识别与空响应拦截
  ├─ src/usage.js             token 用量提取 → ~/.cc-proxy/usage.json（按天）
  ├─ src/debug-log.js         CC_PROXY_DEBUG=1 请求级日志 → ~/.cc-proxy/logs/
  └─ src/logger.js            静默日志（见下方关键约束）
bin/settings-web.js   cc-proxy --setting：本地 Web 设置页 + 受保护 API
  ├─ bin/settings-page.js     设置页 HTML（模板 + 内联脚本，bootstrap nonce 注入）
  └─ bin/settings-session.js  SSE 租约生命周期（页面全关 2s 后退出等）
src/settings.js       ~/.cc-proxy/config.json 读写（缺失/损坏回退默认值）
```

数据流：UA 匹配 `claude-cli`/`claude-code` 的 SSE 流中，thinking 块被改写为 `> 💭 Thinking` dim blockquote 文本流（移植自 agy-cc-proxy）；多轮请求中已渲染的历史思考文本在转发前剥离，防止上下文膨胀。非 CC 客户端、非 SSE、非 message JSON 流量一律原样透传。

## Critical invariants

- **thinking→text 渲染格式必须与 agy-cc-proxy `src/cloudcode/thinking-text-streamer.js` 逐字节兼容**（header 行 + `\n> ...` dim 行、空行跳过、末行无尾随换行）。永远不输出 ANSI 光标控制码（滚动窗口方案因与 Claude Code Ink 渲染器不兼容已废弃）。
- **不参与 thinking 转换的流量必须原样透传**：非 message JSON、错误响应、非 SSE、非 CC UA。
- **代理内部日志默认静默**（`src/logger.js`）。任何 stdout/stderr 输出都会经 stdio 继承泄漏进 Claude Code 的 Ink UI。调试用 `CC_PROXY_LOG=1`（stderr）与 `CC_PROXY_DEBUG=1`（请求日志落盘）。
- 设置页安全链：Host 校验 → Origin 校验 → 一次性 bootstrap nonce（30s/256 容量）→ token；仅监听 127.0.0.1。改动认证链时须保持 token 不进 URL/终端输出。
- 配置写入使用同目录临时文件 + rename 原子替换，新文件 mode 0600、更新保留原 mode。

## OpenSpec

本项目启用 OpenSpec 规范驱动开发（`openspec/`）：`openspec/project.md` 为项目上下文，`openspec/specs/` 为已归档需求事实源（cc-proxy-settings、claude-thinking-text 等 capability），行为级变更应先建 `openspec/changes/<name>/` 提案。用户级 OpenSpec 强制流程（触发评估、AskUserQuestion 门控、sub-agent CR）定义在 `~/.claude/rules/openspec.md`，优先于技能默认流程。
