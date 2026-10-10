## MODIFIED Requirements

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
