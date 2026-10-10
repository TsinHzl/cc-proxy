# 变更提案：add-system-prompt-override

## 背景
Claude Code（CC）每次请求都会携带自身的默认系统提示词（请求体 `system` 字段，块数组形态，带 prompt caching 标记）。用户希望在 cc-proxy 设置页新增「系统提示词覆写」功能：

- **默认关闭**：关闭时 CC 请求原样转发（默认提示词不变），行为与现版本完全一致。
- **开启后可自定义**：设置页输入框默认预填 CC 实际使用的默认系统提示词（由代理从真实请求中捕获），用户可在此基础上修改；生效后所有 CC 请求的 `system` 字段统一替换为用户配置的提示词。
- **提供模板**：设置页预置若干系统提示词模板，用户选择模板后一键填入输入框，再自行修改。

## 目标范围
**在范围内：**
- `src/settings.js`：新增 `systemPromptOverride: { enabled: false, prompt: '' }` 配置项（默认关闭、prompt 为空），normalizeConfig 逐字段容错校验（enabled 非布尔回退 false；prompt 非字符串或超长回退 ''），writeConfig 纳入浅合并
- 新模块 `src/system-prompt.js`：①从 CC 请求体 `system` 字段（string 或 blocks 数组）提取纯文本；②捕获结果持久化到 `~/.cc-proxy/captured-system-prompt.json`（仅文本变化时写盘，mode 0600，容错不抛）；③按开关构造覆写后的 `system` 字段（保留原首块 `cache_control` 以维持 prompt caching）
- `src/proxy.js`：CC UA 请求在现有 JSON.parse 点扩展两个行为——①非 Suggestion Mode 请求捕获 `system` 文本并按需落盘；②开关开启时以配置 prompt 覆写 `system` 字段（`parsed.system` 不存在时不覆写）；开关关闭时不改写（字节透传不变量不破坏）
- `bin/claude-proxy.js`：读取 `systemPromptOverride` 配置并注入 `createProxyServer`
- `bin/settings-web.js`：ALLOWED_KEYS 增加 `systemPromptOverride.enabled`（boolean）与 `systemPromptOverride.prompt`（string，≤ 256KB）；PATCH 正文上限 `MAX_BODY_BYTES` 从 1024 提升到 327680（320KB = prompt 上限 256KB + JSON 包装与转义余量 64KB，避免「通过配置校验却无法提交」的阈值矛盾）；publicSettings 返回 `systemPromptOverride`；新增 `GET /api/captured-system-prompt`（token 保护）返回捕获的 CC 默认提示词
- `bin/settings-page.js`：新增第四张设置卡片「系统提示词覆写」：即时保存开关 + 预置模板下拉（一键填入输入框）+ textarea 输入框（blur 时保存）；开启开关且输入框为空时自动拉取捕获的 CC 默认提示词预填
- 测试：settings 归一化/合并、settings-web PATCH 校验与正文上限、捕获与覆写单元测试、proxy 请求侧行为（开/关/捕获/非 CC UA/非法 JSON/Suggestion 请求不捕获）

**不在范围内：**
- 不覆写非 CC UA 客户端请求
- 不识别「仅主对话请求」——覆写范围是所有 CC 请求（用户已确认），包括转发开启时的 Suggestion Mode 请求（被拦截的建议请求本就不转发）
- 不做提示词版本管理/多套提示词切换
- 不改动 settings-cli（CLI 交互菜单不新增此项）
- `system` 字段不存在的请求（如部分后台请求）不做「补一个 system」——仅替换已存在的

## 技术方案
- **配置结构**：`systemPromptOverride: { enabled: boolean, prompt: string }`，与 `effortOverride` 同构模式；`prompt` 上限 256KB（与 `MAX_THINKING_TEXT_BLOCK_BYTES` 对齐），超长回退 ''
- **空 prompt 语义**：`enabled: true` 且 `prompt` 为空字符串时覆写按 no-op 处理（不改写、字节透传）——空提示词替换只会破坏请求且无意义；设置页文案提示「开启前请先填写提示词或使用模板/预填」。该状态合法可达（无捕获数据时允许先开开关），故以 no-op 兜底而非禁止保存
- **捕获策略**（用户已确认「代理捕获」）：复用 proxy 现有请求体 JSON.parse 点（零额外解析成本）；捕获对象始终是**覆写前的原始 system**（先捕获后覆写），且与开关状态无关（覆写开启期间继续捕获，CC 升级后默认提示词变化仍能更新）；Suggestion Mode 请求（`isSuggestionModeRequest` 命中）的 system 与主对话不同，**不捕获**，避免捕获值在两形态间抖动导致频繁写盘；捕获文本与已落盘内容做字符串比较，仅变化时原子写盘（同 config.json 的临时文件 + rename 模式）
- **覆写构造**：原 `system` 为 string → 替换为配置 prompt（string 形态保持）；原为 blocks 数组 → 替换为单块 `[{ type: 'text', text: prompt, ...(原首块有 cache_control 则原样保留) }]`，保住上游 prompt caching 命中
- **PATCH 协议**：沿用点号 key 展开为嵌套 partial 的既有机制；正文上限提升为 327680 字节（320KB = prompt 上限 256KB + JSON 包装与转义余量 64KB），既有 413/408 边界语义不变、仅阈值变化（prompt 校验上限 262144 与正文上限保持 64KB 余量关系，确保任何通过校验的 prompt 均可提交）
- **预置模板**：3 条非空中文模板，以常量数组内联在 `bin/settings-page.js`（与 PAGE_STYLES/PAGE_BODY 同级）：①「极简模式」— 仅保留核心指令、去除冗余客套；②「中文优先」— 强制全程简体中文回复；③「默认 + 追加规则」— 占位注明可粘贴 CC 默认提示词后追加自定义规则。文案实施时定稿，须为非空占位文本
- **设置页交互**：开关 change → 若开启且输入框为空，先 `GET /api/captured-system-prompt` 预填再 PATCH prompt、PATCH enabled（两步保存，失败回滚权威快照）；textarea blur 时若与权威快照不同则 PATCH prompt；模板下拉 change 仅填充输入框，不直接保存（等用户确认修改后 blur 保存）；页面加载时 textarea 从 `GET /api/settings` 返回的 `systemPromptOverride.prompt` 回填初值（权威快照对比依赖此初值）
- **生效时机**：与其他设置一致——保存即时落盘，**下次启动会话生效**（代理启动时读取一次配置）

## 预期影响
- 现有配置项行为不变；旧配置文件无 `systemPromptOverride` 字段时自动兼容默认 `{ enabled: false, prompt: '' }`（默认关闭 → 升级后行为零变化）
- 新增 `~/.cc-proxy/captured-system-prompt.json` 数据文件（与 config.json / usage.json 并列），CC 版本更新导致默认提示词变化时自动更新捕获
- PATCH 正文上限提升使所有设置 API 请求可携带更大正文（本机 127.0.0.1 + token 保护，滥用面可控）
- 覆写开启后 CC 所有请求的 system 被替换：上游模型行为完全由自定义提示词主导（这正是需求），CC 内置技能/工具说明将缺失，可能影响 CC 功能完整性——**此为用户主动选择的预期行为**，在设置页描述中明确提示

## 风险
- CC 请求 `system` 字段的具体形态（string vs blocks 数组、cache_control 位置）无仓库内实证（grep 零命中）→ 实施任务 3 时先以 `CC_PROXY_DEBUG=1` 采样一次真实请求确认形态；实现同时兼容两种形态（提取与覆写均做 string/blocks 双形态分支），不依赖单一假设
- 覆写破坏 CC 功能（工具调用约定依赖系统提示词时）→ 属预期行为，设置页文案明确警示；开关随时可关回
- 捕获写盘在请求热路径上 → 仅在文本变化时写盘（稳定态零写盘），且写盘失败静默降级（不影响转发）
