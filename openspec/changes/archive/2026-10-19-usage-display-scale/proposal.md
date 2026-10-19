# 变更提案：usage-display-scale

## 背景

Claude Code 按 200K 窗口计算 Ctx%，显示值达到约 82% 时触发 auto-compact。部分第三方网关返回的 usage 计数口径与 Claude Code 的预期不同（如 Kiro 上游返回的是 1M 窗口口径），导致客户端上下文占用显示偏差、auto-compact 触发时机不合预期。

参考 kiro2cc-proxy 的 `clientTokenPassthrough` 反向能力（其通过固定 0.6657 系数缩放展示值控制 auto-compact 时机，并可开关直通真实值），cc-proxy 需要一个对称的通用能力：默认不干预（上游是多少就是多少），用户可按需开启并自定义比例值，缩放返回给客户端的 usage 计数。

## 目标范围

**在范围内：**

- 新增配置 `usageScale: { enabled: false, ratio: 1.0 }`（`~/.cc-proxy/config.json`），默认关闭、默认比例 1.0
- ratio 校验：有限数、(0, 10]；enabled 非布尔回退 false、ratio 非法回退 1.0
- 代理响应侧缩放：仅 CC UA（`claude-cli` / `claude-code`）+ message JSON 流量生效
  - SSE 流式：改写 `message_start.message.usage` 与 `message_delta.usage` 中的 input 类字段
  - 非流式 message JSON：改写 `usage` 中的 input 类字段
  - 缩放字段：`input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`、`cache_creation.ephemeral_5m_input_tokens`、`cache_creation.ephemeral_1h_input_tokens`（存在才改写）【cache 侧字段集为主动超出，经用户确认保留】
  - `output_tokens` 不缩放（避免影响客户端 max_tokens 计算）
  - 缩放结果向上取整（Math.ceil），保证非零值缩放后不为 0
- 内部统计（`usage.json` / usage tracker）始终记录上游真实值，不受缩放影响
- 设置页新增「用量展示缩放」开关 + 比例值输入框（数字输入，blur 提交，校验失败提示）
- 设置 API：`GET /api/settings` 返回 `usageScale`；`PATCH` 支持 `usageScale.enabled` / `usageScale.ratio`
- 测试：settings 归一化、API 校验、代理流式/非流式缩放改写、非 CC UA 透传、output 不缩放

**不在范围内：**

- 不做运行时热切换（配置启动时读取一次，与 forwardSuggestionMode 一致）【用户确认剔除：关闭→开启需重启生效，接受】
- 不改写超窗错误响应中的 token 数值（`error` 类型 JSON 原样透传）【主动超出，经用户确认保留】
- 不改内部计费 / usage tracker / 设置页看板数据（始终真实值）
- 不提供按模型差异化比例
- 非 message JSON、非 SSE、非 CC UA 流量一律原样透传（现有 Critical invariants 不变）

## 技术方案

- 新建 `src/usage-scale.js`：纯函数模块
  - `scaleUsageForClient(usage, ratio)`：对 usage 对象做浅拷贝并缩放 input 类字段，返回新对象（不可变更新）；字段缺失或非正整数时保持原样；ratio=1 时直接返回原对象引用（零改写）
  - `scaleUsageInEvent(event, ratio)`：对 SSE 事件（`message_start` / `message_delta`）返回改写后的新事件对象，其他类型原样返回
  - `scaleUsageInMessageJson(parsed, ratio)`：对非流式 message JSON 返回改写后的新对象
- `src/proxy.js`：`createProxyServer` 新增 `usageScale` 参数（null/未启用 = 零开销路径不变）
  - SSE 路径：在 `transformThinkingAsTextEvents` 迭代输出处对事件做 `scaleUsageInEvent` 改写后再 `writeEvent`
  - 非流式路径：在 `transformNonStreamingResponse` 输出前应用 `scaleUsageInMessageJson`
  - usage 提取（`usage.record`）在缩放前的原始事件/对象上进行，保证内部统计为真实值
- `src/settings.js`：`DEFAULT_CONFIG.usageScale = { enabled: false, ratio: 1.0 }`；normalizeConfig 校验；writeConfig 逐字段合并
- `bin/claude-proxy.js`：读配置传 `usageScale`
- `bin/settings-web.js`：ALLOWED_KEYS 增 `usageScale.enabled` / `usageScale.ratio`；ratio 校验有限数 (0, 10]
- `bin/settings-page.js`：服务卡片新增开关 + `<input type="number">`；blur 提交；invalid 时 CSS 伪类提示；applySettings / authoritativeSnapshot 同步回填
- 测试：`test/usage-scale.test.mjs`（纯函数）+ `test/proxy-usage-scale.test.mjs`（代理集成）+ settings/settings-web 既有文件扩展

## 预期影响

- 默认关闭时行为与现状完全一致（逐字节透传），零风险
- 开启后仅影响 CC 客户端看到的 usage 计数；Claude Code 的 Ctx% 显示与 auto-compact 触发时机随之变化（这正是功能目的）
- 设置页新增一个开关 + 数字输入，UI 结构与 effortOverride 卡片一致
- 性能：SSE 每事件一次浅拷贝判断（非 usage 事件直接返回原引用），开销可忽略

## 风险

- **缩放导致客户端统计偏低/偏高**：功能本身即为此目的（用户自控）；README 需说明作用与默认关闭
- **ratio 配置非法**（0、负数、NaN、>10）：settings 归一化回退 1.0，API 层 400 拒绝，双重防护
- **与 thinking 转换叠加**：两条改写在同一条 SSE 管道上独立执行，互不干扰；usage 改写不触碰 content 块
- **测试盲区**：需覆盖「缩放后内部统计仍为真实值」的回归断言，防止未来重构把缩放误用于 usage.record 上游
