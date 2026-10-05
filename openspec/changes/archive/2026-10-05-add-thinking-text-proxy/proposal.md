# 变更提案：add-thinking-text-proxy

## 背景
Claude Code CLI 在直连 Anthropic API（或任意透传网关）时，深度思考内容以原生 `thinking` 块展示。用户已在 agy-cc-proxy 中实现了一套「thinking → 文本化 blockquote 渲染」功能（`src/cloudcode/thinking-text-streamer.js`，commit `cba41e1`），使 CC 中深度思考以 `> 💭 Thinking` 灰色引文形式流式呈现。希望该能力不依赖 agy-cc-proxy 后端，也能作用于直连官方 API / 任意第三方网关的 Claude Code 会话。

cc-proxy 仓库（当前仅 LICENSE + README）将承载一个本地透明代理实现该功能，并借鉴 claude-tap 的「启动时注入 ANTHROPIC_BASE_URL env 拉起目标 CLI」模式，做到敲 `claude-proxy`（或 `cc-proxy`）即自动启动代理并进入 Claude Code。

## 目标范围
**在范围内：**
- Node.js 零依赖本地 HTTP 代理（127.0.0.1），透明转发 Claude Code 的 `/v1/messages` 等全部流量到上游
- 上游解析：`ANTHROPIC_BASE_URL` 环境变量优先，否则默认 `https://api.anthropic.com`；透传路径与 query
- SSE 流式响应的 thinking 块 → 文本化渲染（移植 `transformThinkingAsTextEvents` 的核心渲染逻辑：header 行、逐行 dim blockquote、跳过空行、无尾随换行、block/response 字节上限、签名事件剥离）
- 请求侧历史剥离：移植 `stripThinkingTextHistory`（含 legacy 格式正则），将后续轮次历史 assistant 消息中已渲染的 `> 💭 Thinking` 文本块剥掉，防止多轮上下文膨胀
- 非流式（`stream: false`）响应中的 thinking 块同样文本化
- 仅对 Claude Code 客户端（User-Agent `claude-cli`/`claude-code`）启用渲染，其他客户端原样透传
- CLI bin `claude-proxy` / `cc-proxy`：启动代理 → 注入 `ANTHROPIC_BASE_URL` → spawn `claude`（透传全部参数）→ claude 退出后联动退出；代理在无活跃连接时随进程退出
- node:test 单元测试覆盖渲染函数与关键流式转换场景

**不在范围内：**
- 多客户端支持（Codex / Gemini CLI 等，claude-tap 已有）
- trace 记录、viewer、dashboard（claude-tap 已有）
- 鉴权、多账号、模型映射、重试/failover 等代理服务端逻辑
- 请求体其他改写（仅做历史 thinking 文本块剥离，见上）

## 技术方案
- 代理核心：`node:http` 起 server；请求处理时向上游发起新请求（按 URL scheme 选择 `node:http`/`node:https`，不关闭证书校验），复写 `Host` header；响应若 `content-type: text/event-stream` 则按 SSE 逐事件解析（复用 agy-cc-proxy 的语义：解析 `event:`/`data:` 行），thinking 块改写为 text 块后回写客户端；否则 pipe 原样透传
- 渲染格式与 agy-cc-proxy 严格对齐（header `> 💭 Thinking` + ANSI dim 逐行引文 + 跳空行 + 无尾随换行），保证两端渲染观感一致；UA 判定逐字沿用 `/^(?:claude-cli|claude-code)(?:\/|\s|$)/i`
- CLI 启动顺序：先 listen 成功取得端口 → spawn `claude`（env 注入 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`，保留原有其余 env）→ 子进程 stdio 继承 → exit code 透传
- thinking delta 到达即流式 flush 已完成行，与 agy-cc-proxy 相同的「新行前置换行」策略

## 预期影响
- 现有功能：cc-proxy 是全新实现，无存量影响；Claude Code 直连官方 API / 第三方网关均可通过 `claude-proxy` 获得文本化思考渲染
- 兼容性：非 CC 客户端流量完全不受影响；`thinkingAsText` 渲染仅在 CC UA + thinking 块出现时改写 SSE 事件
- 性能：单用户本地代理，SSE 逐事件解析开销可忽略

## 风险
- **SSE 解析器精度**：上游 SSE 分帧跨 chunk 时需缓冲完整事件（`\n\n` 分隔），处理不全会丢/粘事件 → 移植 agy-cc-proxy 验证过的缓冲语义
- **格式漂移**：渲染格式若与 agy-cc-proxy 不一致会出现不同观感 → 渲染常量与行策略直接移植，测试断言对齐
- **UA 判定差异**：CC 更新可能改 UA → 沿用 agy-cc-proxy 的 `^(claude-cli|claude-code)[/\s]` 正则，宽松前缀匹配
- **第三方网关非标准响应**：网关可能返回非 Anthropic 格式 → 仅当事件为标准 Anthropic thinking 事件时改写，其余（含 message_start/message_delta/usage/ping）原样转发
