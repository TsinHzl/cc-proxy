# 任务清单：add-system-prompt-override

## 状态：DONE

## 任务- [x] 1. `src/settings.js`：DEFAULT_CONFIG 增加 `systemPromptOverride: { enabled: false, prompt: '' }`（frozen），新增 `MAX_PROMPT_BYTES = 256 * 1024`；normalizeConfig 逐字段校验（enabled 非布尔回退 false；prompt 非字符串或 UTF-8 字节数超上限回退 ''），writeConfig 浅合并纳入 systemPromptOverride；验证：`node --test test/settings.test.mjs` 新增用例全部通过
- [x] 2. 新建 `src/system-prompt.js`：导出 `extractSystemText(system)`（string / blocks 数组双形态提取纯文本，拼接为单个字符串）、`buildOverriddenSystem(currentSystem, prompt)`（保留原首块 cache_control 的单 text 块覆写构造）、`createSystemPromptCapture({ file, now })`（文本变化才写盘，mode 0600 原子替换，读损坏回退 null，全程不抛；落盘 schema 为 `{ prompt: string }` 单字段）；验证：新建 `test/system-prompt.test.mjs` 覆盖双形态提取、覆写构造（含 cache_control 保留）、捕获写盘/不重复写盘/损坏回退
- [x] 3. `src/proxy.js`：createProxyServer 新增 `systemPromptOverride` 与 `systemPromptCapture` 参数；CC UA 且 JSON.parse 成功后——①先捕获：非 Suggestion Mode 请求对**覆写前的原始 system** 调用捕获（与开关状态无关，在 SUGGESTION_MARKER 预筛之后判断）；②后覆写：`systemPromptOverride?.enabled && prompt 非空 && parsed.system 存在` 时用 `buildOverriddenSystem` 覆写并重序列化 body（prompt 为空时覆写 no-op 字节透传）。实施前先以 `CC_PROXY_DEBUG=1` 采样一次真实 CC 请求确认 `system` 字段形态，采样结论记录在本任务备注；验证：新增 `test/proxy-system-prompt.test.mjs`（开/关/空 prompt no-op/捕获/非 CC UA/非法 JSON/Suggestion 不捕获/system 缺失不补）全部通过
- [x] 4. `bin/claude-proxy.js`：readSettings 解构 `systemPromptOverride`，创建 capture 实例并注入 `createProxyServer`；验证：`node --test test/cli.test.mjs` 通过
- [x] 5. `bin/settings-web.js`：ALLOWED_KEYS 增加 `systemPromptOverride.enabled` / `systemPromptOverride.prompt`（string ≤ 262144 字节校验，与 settings.js 上限一致），MAX_BODY_BYTES 1024 → 327680（prompt 上限 + 64KB 包装余量，确保通过校验的 prompt 均可提交），publicSettings 返回 `systemPromptOverride`，新增 `GET /api/captured-system-prompt`（token 保护，返回 `{ ok, data: { prompt } }`，未捕获时 prompt 为 null）；验证：`node --test test/settings-web.test.mjs` 新增 PATCH/GET/正文上限用例通过
- [x] 6. `bin/settings-page.js`：新增「系统提示词覆写」卡片（开关 + 模板下拉 + textarea），页面脚本：controls 纳入三个新控件；页面加载时 textarea 从 `GET /api/settings` 返回的 `systemPromptOverride.prompt` 回填初值；开关 change 时开启且输入框为空则先拉取捕获提示词预填（拉取失败仍继续保存 enabled）；textarea blur 与快照不同则 PATCH prompt；模板下拉 change 仅填入输入框不保存；3 条预置中文模板常量（极简模式/中文优先/默认+追加规则，文案实施时定稿）；textarea 样式与现有深色主题一致；验证：`cc-proxy --setting` 手动目检 + settings-web 页面脚本测试通过
- [x] 7. 全量测试回归：`node --test --test-timeout=15000 "test/"*.test.mjs` 全部通过；同步修正 settings-cli 快照类测试（若因新增默认字段失败）；验证：0 failing
- [x] 8. README.md「设置页」章节补充系统提示词覆写说明（开关语义、捕获机制、模板、生效时机与功能完整性警示）；验证：文档与实现一致

## 验收标准
- [x] 设置页展示「系统提示词覆写」卡片，开关默认关闭；开启后出现模板下拉与 textarea 输入框
- [x] 关闭状态下 CC 请求字节行为与现版本一致（不做任何 system 改写），仅捕获行为新增（写盘容错、不影响转发）
- [x] 开启后所有 CC 请求的 `system` 字段被替换为配置提示词；原字段不存在时不补写
- [x] 首次开启且输入框为空时，输入框自动预填捕获的 CC 默认系统提示词（无捕获数据时保持为空，不报错）
- [x] 模板下拉选择后一键填入输入框，用户修改后 blur 保存；保存期间全部控件禁用，失败回滚权威快照
- [x] 配置持久化到 `~/.cc-proxy/config.json`，旧配置文件自动兼容默认值，非法值逐字段回退不抛异常
- [x] PATCH 非法 prompt（非字符串/超 256KB）返回 4xx 且配置不变；正文上限（320KB）与 prompt 校验上限（256KB）保持 64KB 余量关系，边界语义正确
- [x] `enabled: true` 且 `prompt` 为空时覆写按 no-op 处理（不改写请求，字节透传），不产生空 system 的破坏性请求
- [x] 全部测试通过（0 failing）
