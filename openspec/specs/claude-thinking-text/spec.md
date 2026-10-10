# claude-thinking-text

## Purpose
cc-proxy 本地透明代理为 Claude Code 客户端提供深度思考文本化渲染能力：将上游 Anthropic SSE 流中的 thinking 块转换为 Claude Code 可直接展示的 dim blockquote 文本块，格式与 agy-cc-proxy 实现保持一致。

## Requirements

### Requirement: thinking 块文本化渲染
代理 SHALL 在 `thinkingAsText=true`、响应为 SSE 且客户端 UA 匹配 `/^(?:claude-cli|claude-code)(?:\/|\s|$)/i` 时，将流中的 thinking 内容块转换为 text 内容块：首 delta 为 header 行 `> \x1b[2m💭 Thinking\x1b[0m`，后续每行为 `\n> \x1b[2m<line>\x1b[0m`；`thinkingAsText=false` 时 SHALL 保留原生 thinking 事件语义。

#### Scenario: 文本化模式
- **GIVEN** `thinkingAsText=true`
- **WHEN** 上游发出 thinking content_block_start、thinking_delta、signature_delta 与 content_block_stop
- **THEN** 客户端收到同 index 的 text content_block_start、header 与逐行 text_delta、content_block_stop
- **AND** signature_delta 不转发给客户端

#### Scenario: 原生思考模式
- **GIVEN** `thinkingAsText=false`
- **WHEN** 上游发出 thinking content_block_start、thinking_delta、signature_delta 与 content_block_stop
- **THEN** 客户端收到相同类型、顺序、index 和内容的事件
- **AND** Claude Code 可使用原生折叠 thinking 展示

#### Scenario: 非 thinking 事件原样透传
- **WHEN** 流中出现 `message_start`、`message_delta`、`ping`、非 thinking 内容块或 `error` 事件
- **THEN** 两种思考展示模式下事件顺序、index 与 usage 均保持不变

#### Scenario: 空行与结尾格式
- **GIVEN** `thinkingAsText=true`
- **WHEN** thinking 内容包含空白行并结束
- **THEN** 空白行不产生空 quote delta
- **AND** 最后一个 text_delta 不带尾随换行

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
代理 SHALL 对 CC UA 的非流式 message JSON 按 `thinkingAsText` 配置处理：开启时将 thinking content 块转换为带 header 的 dim blockquote text 块并剥离签名；关闭时 SHALL 保留原始响应 body 与 thinking signature。非 message JSON 与错误响应 SHALL 原样透传。

#### Scenario: 非流式文本化
- **GIVEN** `thinkingAsText=true`
- **WHEN** 上游返回 content 含带 `signature` thinking 块的非流式 message JSON
- **THEN** 客户端收到对应 text 块
- **AND** 响应不包含 thinking signature

#### Scenario: 非流式原生思考
- **GIVEN** `thinkingAsText=false`
- **WHEN** 上游返回 content 含带 `signature` thinking 块的非流式 message JSON
- **THEN** 客户端收到原始响应 body
- **AND** thinking 块及 signature 保持不变

#### Scenario: 非 message JSON 透传
- **WHEN** 上游返回普通 JSON 错误体或其他非 message JSON
- **THEN** 状态码、headers 与 body 原样返回

### Requirement: 非 SSE 流量透传
代理 SHALL 对 CC UA 的成功 message JSON 按 `thinkingAsText` 配置处理；其他非 SSE 响应 SHALL 将 headers、status 与 body 原样透传。

#### Scenario: 普通错误响应
- **WHEN** 上游返回 `application/json` 错误体
- **THEN** 状态码、headers 与 body 原样返回

#### Scenario: 非 CC 客户端
- **WHEN** 非 Claude Code 客户端收到非 SSE 响应
- **THEN** 状态码、headers 与 body 原样返回

### Requirement: CLI 一键启动
`claude-proxy` / `cc-proxy` 命令 SHALL 先启动本地代理（127.0.0.1 随机可用端口），再以注入 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` 的 env spawn `claude`（透传全部 CLI 参数与 stdio），claude 退出后进程 SHALL 以相同退出码退出。

#### Scenario: 启动联动
- **WHEN** 用户执行 `claude-proxy -c`
- **THEN** 代理监听本地端口、`claude -c` 被拉起且 env 中 ANTHROPIC_BASE_URL 指向代理
- **AND** claude 退出时代理进程随之退出
