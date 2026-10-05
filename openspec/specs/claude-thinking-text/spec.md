# claude-thinking-text

## Purpose
cc-proxy 本地透明代理为 Claude Code 客户端提供深度思考文本化渲染能力：将上游 Anthropic SSE 流中的 thinking 块转换为 Claude Code 可直接展示的 dim blockquote 文本块，格式与 agy-cc-proxy 实现保持一致。

## Requirements

### Requirement: thinking 块文本化渲染
代理 SHALL 在响应为 SSE 且客户端 UA 匹配 `/^(?:claude-cli|claude-code)(?:\/|\s|$)/i` 时，将流中的 thinking 内容块转换为 text 内容块：首 delta 为 header 行 `> \x1b[2m💭 Thinking\x1b[0m`，后续每行为 `\n> \x1b[2m<line>\x1b[0m`。

#### Scenario: 非 thinking 事件原样透传
- **WHEN** 流中出现 `message_start`、`message_delta`（含 usage/output_tokens）、`ping`、`content_block_start/stop`（text/tool_use 等非 thinking 类型）、`error` 事件
- **THEN** 全部事件原样透传，事件顺序、index、usage 计数不变

#### Scenario: 常规 thinking 块渲染
- **WHEN** 上游发出 thinking content_block_start、thinking_delta（含 `line one\r\n\r\nline two`）、content_block_stop
- **THEN** 客户端收到同 index 的 text content_block_start、header text_delta、`\n> …line one…`、`\n> …line two…` 两个 text_delta、content_block_stop
- **AND** signature_delta 事件被剥离，不转发给客户端

#### Scenario: 空行跳过
- **WHEN** thinking 内容包含空白行（如 `\r\n\r\n`）
- **THEN** 不为空行输出任何空 quote 行 delta（避免 Claude Code 左侧竖线多出一截）

#### Scenario: 无尾随换行
- **WHEN** thinking 块结束
- **THEN** 最后一个 text_delta 以 `\x1b[0m` 结尾，不以 `\n` 结尾

### Requirement: 空白 thinking 块不产生孤立事件
代理 SHALL 在 thinking 块全部内容为空白且未发出任何事件时，跳过该块的 start/stop 事件，客户端不得收到无配对 start 的 content_block_stop。

#### Scenario: 纯空白 thinking
- **WHEN** thinking 块仅有 `\n\n` 内容
- **THEN** 该 index 上无任何事件输出

### Requirement: 字节上限保护
代理 SHALL 对单个 thinking 块（256 KiB）与单响应全部 thinking 内容（1 MiB）设字节上限，超限时丢弃该块剩余渲染并记录告警，不影响其他块与后续 text 内容转发。

#### Scenario: 超限块丢弃
- **WHEN** 单个 thinking 块内容超过 256 KiB
- **THEN** 该块不再产生任何 text 事件，后续 text 块正常转发

### Requirement: 上游解析与透传
代理 SHALL 以 `ANTHROPIC_BASE_URL` 环境变量为上游地址（未设置时默认 `https://api.anthropic.com`），将请求的路径与 query 原样拼接转发，并按 URL scheme 选择 `node:http`/`node:https` 模块。

#### Scenario: env 上游
- **WHEN** `ANTHROPIC_BASE_URL=https://gw.example.com/api` 且请求路径为 `/v1/messages?beta=true`
- **THEN** 上游请求为 `https://gw.example.com/api/v1/messages?beta=true`

#### Scenario: 默认上游
- **WHEN** `ANTHROPIC_BASE_URL` 未设置
- **THEN** 上游请求发往 `https://api.anthropic.com`（同路径拼接规则）

### Requirement: 请求侧历史剥离
代理 SHALL 在 CC UA 请求的 messages 中，将 assistant 历史消息里已渲染的 thinking 文本块（首行为 `> \x1b[2m💭 Thinking\x1b[0m` 或 legacy 无 ANSI 变体）剥离，防止多轮上下文膨胀。

#### Scenario: 历史渲染文本剥离
- **WHEN** 请求 messages 的 assistant content 含已渲染的 `> 💭 Thinking` blockquote 文本块
- **THEN** 该文本块在转发给上游前被移除，其余 content 原样保留

### Requirement: 非目标客户端透明透传
代理 SHALL 在客户端 UA 不匹配 Claude Code 模式时原样转发全部 SSE 事件，不做任何 thinking 改写。

#### Scenario: 非 CC UA
- **WHEN** 请求 UA 为 `anthropic-sdk-node/0.39.0`
- **THEN** thinking_delta 与 signature_delta 原样转发

### Requirement: 非流式响应文本化
代理 SHALL 对 `stream: false` 响应 JSON 中的 thinking content 块做同等文本化（拼接为带 header 的 dim blockquote 文本块），仅对 CC UA 生效；无论块是否携带 `signature`，均 SHALL 转为 text 块并剥离签名（与流式剥离 signature_delta 行为对称）。

#### Scenario: 非流式有签名 thinking
- **WHEN** 上游返回非流式 JSON，content 含带 `signature` 的 thinking 块
- **THEN** 客户端收到 type=text 的块，文本以 header 行开头、blockquote 逐行渲染，且无 `signature` 字段

### Requirement: 非 SSE 流量透传
代理 SHALL 将非 `text/event-stream` 响应（含 headers、status、body）原样透传，不改写。

#### Scenario: 普通响应
- **WHEN** 上游返回 `application/json` 错误体（如 429）
- **THEN** 状态码、headers、body 与上游一致地返回给客户端

### Requirement: CLI 一键启动
`claude-proxy` / `cc-proxy` 命令 SHALL 先启动本地代理（127.0.0.1 随机可用端口），再以注入 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 的 env spawn `claude`（透传全部 CLI 参数与 stdio），claude 退出后进程 SHALL 以相同退出码退出。

#### Scenario: 启动联动
- **WHEN** 用户执行 `claude-proxy -c`
- **THEN** 代理监听本地端口、`claude -c` 被拉起且 env 中 ANTHROPIC_BASE_URL 指向代理
- **AND** claude 退出时代理进程随之退出
