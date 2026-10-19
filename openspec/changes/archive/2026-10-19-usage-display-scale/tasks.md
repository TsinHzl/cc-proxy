# 任务清单：usage-display-scale

## 状态：ARCHIVED

## 任务
- [x] T1 新建 `src/usage-scale.js` 纯函数模块（scaleUsageForClient / scaleUsageInEvent / scaleUsageInMessageJson），配套 `test/usage-scale.test.mjs`：验证 input 类字段缩放、output 不缩放、字段缺失保持原样、ratio=1 返回原引用、向上取整——`node --test test/usage-scale.test.mjs` 通过
- [x] T2 `src/settings.js`：DEFAULT_CONFIG 增 `usageScale`、normalizeConfig 校验（enabled 布尔 / ratio 有限数 (0,10]）、writeConfig 逐字段合并，扩展 `test/settings.test.mjs` 断言默认值与非法回退——`node --test test/settings.test.mjs` 通过
- [x] T3 `src/proxy.js`：createProxyServer 增 `usageScale` 参数，SSE 路径在 writeEvent 前对事件应用 scaleUsageInEvent、非流式路径在输出前应用 scaleUsageInMessageJson；usage.record 仍用缩放前数据，新建 `test/proxy-usage-scale.test.mjs` 验证流式/非流式缩放、非 CC UA 透传、内部统计为真实值、enabled=false 且 ratio≠1 不缩放、ratio=2 放大——`node --test test/proxy-usage-scale.test.mjs` 通过
- [x] T4 `bin/claude-proxy.js` 传 `usageScale`；`bin/settings-web.js` ALLOWED_KEYS 增两项 + ratio 校验（400）；`bin/settings-page.js` 新增「用量展示缩放」开关 + 数字输入框（blur 提交 / 回填 / 禁用联动），扩展 `test/settings-web.test.mjs`——`node --test test/settings-web.test.mjs` 通过
- [x] T5 README.md 使用文档补充「用量展示缩放」小节（配置字段、默认值、作用范围、auto-compact 影响、示例 JSON）；CLAUDE.md 架构清单补 `src/usage-scale.js` 一行——文档评审通过

## 验收标准
- [ ] 默认配置（未设置 usageScale 或 enabled=false）时代理行为与现状逐字节一致：SSE / 非流式 usage 原样透传（含 enabled=false 且 ratio≠1 场景），全量测试通过
- [ ] 开启 usageScale（ratio=0.5）后：CC UA 流量的 message_start / message_delta / 非流式 usage 中 input 类字段 = ceil(原值 × 0.5)，output_tokens 不变；ratio=2.0 时字段 = ceil(原值 × 2)
- [ ] 非 CC UA、非 message JSON、错误响应的 usage 一律原样透传
- [ ] usage.json 内部统计与设置页看板显示真实值（缩放仅作用于客户端可见响应）
- [ ] 设置页开关 + 比例输入可用：开关切换即时写盘、比例 blur 提交、非法值被 API 拒绝（400）且页面回滚
- [ ] ratio 非法（0 / 负数 / NaN / >10 / 非数值）时配置回退默认 1.0，代理不崩溃
