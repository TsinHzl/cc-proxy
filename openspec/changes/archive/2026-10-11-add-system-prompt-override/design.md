# 技术方案：add-system-prompt-override

## 上下文
cc-proxy 是本地透明代理，核心不变量之一是「不参与改写的流量字节级透传」。本变更在 CC UA 请求的现有 JSON.parse 点（stripThinkingTextHistory / effortOverride 共用）扩展捕获与覆写两个行为，并新增一张设置页卡片。捕获结果独立落盘（不进 config.json），因为它是代理观测数据而非用户设置。

## 目标 / 非目标
**目标：**
- 关闭（默认）零行为变化；开启后所有 CC 请求 system 被替换
- 设置页可查看/编辑自定义提示词，可用模板起步，首次开启自动预填 CC 默认提示词

**非目标：**
- 不识别主对话/后台请求差异（覆写全量 CC 请求，用户已确认）
- 不做多套提示词管理与版本历史
- 不改 settings-cli

## 决策

### D1：预填来源 = 代理捕获（用户已确认，三选一决策）
输入框预填的「CC 默认系统提示词」不采用静态内置副本（随 CC 版本漂移过期、体积大），而是代理从真实请求 `system` 字段捕获并落盘 `~/.cc-proxy/captured-system-prompt.json`。代价：全新安装且未跑过会话时无捕获数据——此时输入框保持为空，靠模板兜底，不视为错误。

### D2：捕获排除 Suggestion Mode 请求
建议请求的 system 与主对话不同。若不过滤，捕获值会在两形态间抖动，导致捕获文件反复重写且预填内容不稳定。实现上复用 proxy 现有 `SUGGESTION_MARKER` includes 预筛 + `isSuggestionModeRequest` 精确判断（与拦截路径同一套判定），命中即跳过捕获。

### D3：覆写保留 cache_control
CC 请求 system 块数组首块通常带 `cache_control`（prompt caching 断点）。覆写为单 text 块时把原首块的 `cache_control` 原样带到新块，避免上游缓存完全失效造成 token 成本上涨。字符串形态 system（无 cache_control 概念）直接替换。

### D4：PATCH 正文上限 1024 → 327680（320KB）
全局阈值提升。理由：自定义提示词轻松超过 1KB，旧上限下功能不可用。prompt 校验上限 262144（256KB，与 `MAX_THINKING_TEXT_BLOCK_BYTES` 对齐），正文上限留 64KB 余量容纳 JSON 包装与转义膨胀（中文/emoji 等多字节与控制字符转义），确保任何通过配置校验的 prompt 均可经设置页提交——两阈值若相同会出现「通过校验却无法提交」的矛盾。影响面：设置 API 仅监听 127.0.0.1 + token 保护 + 5s 正文超时不变，滥用面可控。既有 413 测试用例阈值同步调整（1024 精确边界 → 327680 精确边界）。

### D5：空 prompt 时覆写 no-op
`{ enabled: true, prompt: '' }` 是合法可达状态（无捕获数据时允许先开开关再填写）。空字符串替换 system 只会产生空 system 的破坏性请求，故覆写条件为 `enabled && prompt 非空 && parsed.system 存在`；prompt 为空时按 no-op 字节透传。设置页文案提示「开启前请先填写提示词或使用模板/预填」。

### D6：捕获先于覆写、与开关无关
捕获对象始终是覆写前的原始 system（实现顺序：先捕获后覆写），且与开关状态无关——覆写开启期间继续捕获原始值，保证 CC 版本更新导致默认提示词变化时捕获文件仍能自动更新，不被用户自定义 prompt 污染。

### D7：设置页保存时序 = 开关两步、输入框 blur 单步
- 开关 change：若「开启且输入框为空」→ 先 GET 捕获提示词预填，再 PATCH prompt、PATCH enabled（保证首次开启即带着预填内容生效）；否则仅 PATCH enabled
- textarea blur：内容与权威快照不同才 PATCH prompt
- 模板下拉 change：仅填输入框，不保存（用户还有修改机会，避免模板原文被意外生效）
失败路径统一回滚权威快照（`acceptSettings` 既有机制）。

### D8：捕获写盘策略 = 文本变化才写、原子替换、0600
与 config.json 同款临时文件 + rename 模式；稳定态（文本未变）零写盘，请求热路径无写盘开销。写盘失败静默降级（与 debug-log 同哲学：辅助数据绝不影响代理流量）。

### D9：新模块 src/system-prompt.js 单独成文件
提取/构造/捕获三个纯函数 + 一个工厂，独立可测；proxy.js 只做接线，避免其继续膨胀。文件命名与 suggestion-mode.js / thinking-text.js 的既有风格一致。

> 归档备注：delta spec 因目标 capability `cc-proxy-settings` 已有主 spec.md 而不写 `## Purpose` 段（归档时会被忽略）；阶段 4 归档时需将 Purpose 描述手动并入主 spec 的 Purpose 段。

## 风险 / 权衡
- **system 字段形态无仓库内实证**（grep 全仓库零命中）：实现按 string / blocks 双形态分支兼容，不依赖单一假设；任务 3 实施时以 CC_PROXY_DEBUG=1 实机采样确认形态并记录备注（沿用 effort-override 的实证流程）
- **覆写破坏 CC 功能完整性**：CC 内置工具/技能说明依赖系统提示词，覆写后可能失效——这是需求本意（用户主动替换），设置页文案明确警示
- **覆写开启时 body 整体重序列化**：system 以外字段的序列化格式可能与上游原始字节不同（与 effortOverride 既有模式一致，属沿用而非新风险）
- **PATCH 上限提升扩大请求体面**：本机监听 + token + 超时三重既有防线不变，风险可接受
- **捕获文件与 config.json 的 enabled/prompt 语义耦合**：捕获文件只是「上次观测到的 CC 默认值」，用户手动清空/删除该文件时设置页预填降级为空，属可接受降级

## 迁移方案
无需迁移：旧配置文件无 `systemPromptOverride` 字段时 normalizeConfig 补默认值 `{ enabled: false, prompt: '' }`（默认关闭 → 升级零行为变化）；捕获文件首次运行会话后自然出现。

## 待决问题（Open Questions）
无——预填来源、模板形式、覆写范围三项均已经 AskUserQuestion 由用户确认。
