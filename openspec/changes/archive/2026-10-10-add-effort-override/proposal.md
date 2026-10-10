# 变更提案：add-effort-override

## 背景
Claude Code 客户端会在请求体中携带本地配置的 effort 档位（low/medium/high）。用户希望在 cc-proxy 设置页新增一个「Effort 覆写」功能：开启后，无论 CC 本地 effort 设置是什么，代理都统一改写为 cc-proxy 配置的档位。默认开启且档位为 high。

## 目标范围
**在范围内：**
- `src/settings.js`：新增 `effortOverride: { enabled: true, level: 'high' }` 配置项（默认开启、默认 high），normalizeConfig / writeConfig 按既有容错与浅合并模式扩展
- `bin/settings-web.js`：ALLOWED_KEYS 增加 `effortOverride.enabled` 与 `effortOverride.level`（level 校验仅接受 `low|medium|high`），publicSettings 返回该配置
- `bin/settings-page.js`：新增第三张设置卡片「Effort 覆写」：一个即时保存开关 + 档位选择（low / medium / high），复用现有深色卡片与保存状态机
- `bin/claude-proxy.js`：读取 `effortOverride` 配置并注入 `createProxyServer`
- `src/proxy.js`：CC UA 请求体（JSON、messages 数组存在）在转发前，当 `effortOverride.enabled` 为 true 时将请求中的 effort 档位统一覆写为配置值（top-level `effort` 字段；若请求体携带 `output_config.effort` 变体亦一并覆写），开关关闭时不做任何改写（字节透传不变量不破坏）
- 测试：settings.js 归一化/合并、settings-web PATCH 校验、proxy 请求侧覆写（覆盖 开/关/档位/非 CC UA 不改写/非法 JSON 透传）

**不在范围内：**
- 不改写非 CC UA 客户端的请求
- 不新增 CLI 参数，不改动 settings-cli
- 不处理 effort 以外的模型参数（temperature、max_tokens 等）
- 旧配置文件无 `effortOverride` 字段时按默认 `{ enabled: true, level: 'high' }` 兼容

## 技术方案
- 配置结构与 `thinkingWindow` 同构：`effortOverride: { enabled: boolean, level: 'low'|'medium'|'high' }`，非法值逐字段回退默认（enabled 非布尔回退 true，level 非枚举回退 'high'）
- 生效点复用 `src/proxy.js` 现有 CC UA 请求体 JSON.parse 点（stripThinkingTextHistory 同一 try 块内），避免二次解析；开启时设置 `parsed.effort = level`，并与 thinkingWindow 写盘路径共享「顶层键必须参与合并」的浅合并约束
- 设置页 PATCH 协议扩展：`key` 支持 `effortOverride.enabled`（boolean）与 `effortOverride.level`（string 枚举），`isValidSettingsPatch` 按 key 分流校验 value 类型
- 页面脚本 `fields` 状态机增加 effortOverride 三控件，档位选择用三个 radio 样式按钮，保存期间同样全控件禁用

## 预期影响
- 现有三个配置项（thinkingWindow / forwardSuggestionMode / thinkingAsText）行为不变；旧配置文件无新字段时自动兼容默认值
- **注意：effortOverride 默认开启，是对现有转发行为的主动变更**（升级后 CC 请求体即被改写 effort），此为用户明确需求（「默认打开且为high」），非意外副作用
- 请求体改写仅影响 CC UA 请求的 effort 字段，其余字段与转发链路不变
- 上游不认识 effort 字段时由上游自行忽略，代理不做探测

## 风险
- CC 请求体中 effort 字段的具体形态（top-level `effort` vs `output_config.effort`）**当前无实证**（grep 全仓库零命中），可能随 CC 版本变化 → 实施时先以 `CC_PROXY_LOG=1`（debug-log）采样一次真实 CC 请求确认字段形态，再按实证落点实现覆写；同时覆写 top-level `effort` 与 `output_config.effort` 两种形态兜底，采样结论记录进任务 5
- level 枚举扩展（未来新增档位）→ 枚举集合集中在 settings.js 单点定义
