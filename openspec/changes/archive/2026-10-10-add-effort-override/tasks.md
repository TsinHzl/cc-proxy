# 任务清单：add-effort-override

## 状态：ARCHIVED

## 任务
- [x] 1. `src/settings.js`：DEFAULT_CONFIG 增加 `effortOverride: { enabled: true, level: 'high' }`（frozen），normalizeConfig 逐字段校验（enabled 非布尔回退 true；level 非枚举回退 'high'），writeConfig 浅合并纳入 effortOverride（逐字段合并，同 thinkingWindow 模式）；验证：node --test settings 相关测试全部通过
- [x] 2. `bin/settings-web.js`：ALLOWED_KEYS 增加 `effortOverride.enabled` / `effortOverride.level`，isValidSettingsPatch 按 key 分流校验（enabled→boolean，level→'low'|'medium'|'high'），PATCH 写入与 publicSettings 返回 effortOverride；验证：settings-web 测试新增 PATCH 用例通过
- [x] 3. `bin/settings-page.js`：新增「Effort 覆写」卡片（开关 + low/medium/high 档位选择），页面脚本 fields 状态机纳入三控件，保存期间禁用全部控件并按权威快照恢复；验证：手动 `cc-proxy --setting` 目检（无该文件自动化测试）
- [x] 4. `bin/claude-proxy.js`：readSettings 解构 `effortOverride` 并注入 `createProxyServer`；验证：`node --test test/cli.test.mjs` 通过
- [x] 5. `src/proxy.js`：createProxyServer 新增 effortOverride 参数，CC UA 请求体 JSON.parse 成功后、转发前按开关覆写 effort 字段（实施前先以 `CC_PROXY_LOG=1` 采样一次真实 CC 请求确认字段形态，采样结论记录在本任务备注；兜底覆写 top-level `effort` 与 `output_config.effort` 两种形态），开关关闭或非 CC UA 或非法 JSON 时不改写；验证：新增 proxy 请求侧覆写测试（开/关/档位/非 CC UA/非法 JSON）通过
  - 备注：字段形态经 claude-code-guide 确认（未实机采样）：CC 当前将 effort 放在 `output_config.effort`（GA，无需 beta header），取值 low/medium/high（xhigh/max 部分模型支持）；实现按 tasks.md 要求同时兜底覆写 top-level `effort`。测试见 `test/proxy-effort.test.mjs`（5 用例全过）。
- [x] 6. 全量测试回归：`node --test --test-timeout=15000 "test/"*.test.mjs` 全部通过；验证：0 failing
  - 备注：全量 185 tests / 185 pass / 0 fail；settings-cli 两处 deepEqual 快照因新增 effortOverride 默认字段同步补齐。

## 验收标准
- [x] 设置页展示 Effort 覆写卡片，开关默认开启、档位默认 high，修改即时保存并持久化到 `~/.cc-proxy/config.json`
- [x] 开关开启时，CC 发出的请求经代理转发后 effort 档位始终为配置值（无论 CC 本地设置是什么）
- [x] 开关关闭时，请求体与现版本字节行为一致（不做任何 effort 改写）
- [x] 旧配置文件（无 effortOverride 字段）读取后自动得到默认 `{ enabled: true, level: 'high' }`，不报错
- [x] 非法配置值（enabled 非布尔 / level 非枚举）逐字段回退默认，不抛异常
- [x] PATCH 提交非法 level（如 'extreme'）时 API 返回 4xx 且配置文件不发生变化
- [x] 全部测试通过（0 failing）
