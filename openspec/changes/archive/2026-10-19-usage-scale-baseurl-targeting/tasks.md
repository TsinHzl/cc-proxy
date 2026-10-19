# 任务清单：usage-scale-baseurl-targeting

## 状态：ARCHIVED

## 任务
- [x] T1 匹配原语：src/usage-scale.js 新增 normalizeScaleBaseUrl / buildScaleTargetSet / isScaleTargetHit；test/usage-scale.test.mjs 补规范化（尾斜杠、缺省端口归一、路径保留）与匹配（空路径全命中、段前缀命中、跨段不命中）单元测试 — 验证：node --test test/usage-scale.test.mjs
- [x] T2 配置层：settings.js usageScale 增 baseUrls 默认 []、normalizeConfig 逐项校验丢弃非法、writeConfig 浅合并沿用；test/settings.test.mjs 补默认值/非法丢弃/合法保留用例 — 验证：node --test test/settings.test.mjs
- [x] T3 设置 API：settings-web.js ALLOWED_KEYS 增 'usageScale.baseUrls'、isValidSettingsPatch 增数组校验分支（同 normalizeConfig 口径）；test/settings-web.test.mjs 补 PATCH 合法/非法 400/非数组 400 用例 — 验证：node --test test/settings-web.test.mjs
- [x] T4 upstream.js：onFailover 追加第 4 参数 toEntry（向后兼容）；test/upstream-failover.test.mjs 补断言第 4 参数携带 entry — 验证：node --test test/upstream-failover.test.mjs
- [x] T5 proxy 命中跟踪与定向缩放：buildTargets entry 附加 base、activeUpstreamBase 跟随 onFailover 更新、respond 内计算 effectiveScaleRatio 并用于 SSE 与非流式；test/proxy-usage-scale.test.mjs 补主命中/主不命中/failover 备用命中/failover 备用不命中/空列表全缩放集成测试 — 验证：node --test test/proxy-usage-scale.test.mjs
- [x] T6 设置页：新建 bin/settings-page-scaletargets.js（HTML + 脚本片段）并接入 settings-page.js（列表渲染、增删行、blur 全量提交、本地非法拦截回滚）；test/settings-web.test.mjs 页面 harness 补列表交互用例 — 验证：node --test test/settings-web.test.mjs
- [x] T7 文档与全量回归：README「用量展示缩放」小节补 baseUrls 字段说明、匹配规则与「全部非法丢弃后退化为全量缩放」边界说明、CLAUDE.md 架构树补 settings-page-scaletargets.js；核对 bin/claude-proxy.js usageScale 为整对象透传（baseUrls 天然携带，无需改动则记录走查结论）— 验证：npm test（node --test --test-timeout=15000 "test/"*.test.mjs）全量通过
- [x] T8 收尾核对：确认 bin/settings-page.js 与 bin/settings-page-scaletargets.js 均 <800 行、未配置 baseUrls 时既有 usage-scale 测试全绿 — 验证：wc -l + npm test

## 验收标准
- [ ] baseUrls 未配置/空数组时：enabled=true 全量缩放、enabled=false 全透传，与归档版 usage-display-scale 行为一致（既有测试全绿）
- [ ] baseUrls 配置后：命中上游缩放、未命中上游 usage 字段逐字节透传；failover 切换后按最终命中上游判定
- [ ] 手改 config.json 含非法 URL 项时：非法项丢弃、合法项生效、代理不崩溃
- [ ] 设置页可增删改目标上游行；非法 URL 本地提示且不提交；提交成功后刷新回显正确
- [ ] 设置 API 对非法数组（非数组/含非字符串/不可解析 URL/非 http(s) 协议）返回 400
- [ ] 全量测试通过；bin/settings-page.js 与新模块均 <800 行
