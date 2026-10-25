# 任务清单：effort-override-baseurl-targeting

## 状态：ARCHIVED

## 任务
- [x] T1 公共匹配模块：新建 src/base-url-match.js（normalizeBaseUrl / buildBaseUrlTargetSet / isBaseUrlTargetHit，语义与现 usage-scale 实现一致）；src/usage-scale.js 改为导入并删除本地副本；匹配测试拆至 test/base-url-match.test.mjs — 验证：node --test test/base-url-match.test.mjs test/usage-scale.test.mjs
- [x] T2 配置层：settings.js DEFAULT_CONFIG.effortOverride 增 baseUrls: []、normalizeConfig 复用逐项校验丢弃非法项；test/settings.test.mjs 补默认值 / 非法丢弃 / 合法保留 / 覆写合并保留用例 — 验证：node --test test/settings.test.mjs
- [x] T3 设置 API：settings-web.js ALLOWED_KEYS 增 'effortOverride.baseUrls'、抽 isValidBaseUrlArray 共用、'.baseUrls' key 统一 trim；test/settings-web.test.mjs 补 PATCH 合法 / 非法 400 / 非数组 400 用例 — 验证：node --test test/settings-web.test.mjs
- [x] T4 转发层：upstream.js attempt 改用 entry.body ?? bodyBuffer 并让 forwardRequest / respond 均传实际体；test/upstream-failover.test.mjs 补逐 entry body 断言 — 验证：node --test test/upstream-failover.test.mjs test/upstream-retry.test.mjs
- [x] T5 proxy 定向覆写：buildTargets entry 字段 scaleBase→base；CC UA 分支构造 baseBody / overrideBody 并按 effortTargetSet 逐 entry 赋 body；test/proxy-effort.test.mjs 补命中 / 未命中 / 空列表 / 双向 failover 用例 — 验证：node --test test/proxy-effort.test.mjs
- [x] T6 设置页列表工厂：settings-page-scaletargets.js 改造为 settings-page-targetlist.js 的 createTargetListFragment 工厂；settings-page.js 两次实例化（scale / effort）、setDisabled 双 sync、applySettings / acceptSettings 增加 effortOverride.baseUrls；test/settings-web.test.mjs 补 effort 列表用例并回归既有 scale 用例；行数控制：settings-page.js 净增 ≤ 15 行（工厂模块额外导出 html / syncControls / render / snapshot 供接线），越限则把 Effort 卡片 HTML 一并下沉至工厂模块 — 验证：node --test test/settings-web.test.mjs + wc -l bin/settings-page.js
- [x] T7 文档与全量回归：README 新增「Effort 覆写」小节（baseUrls、匹配规则、空列表 = 全量、failover 逐 entry 语义、全部非法退化为全量）、CLAUDE.md 架构树更新 base-url-match.js 与 targetlist 模块；核对 bin/claude-proxy.js effortOverride 整对象透传（baseUrls 天然携带，记录走查结论）— 验证：npm test（node --test --test-timeout=15000 "test/"*.test.mjs）
- [x] T8 收尾核对：确认 bin/settings-page.js、bin/settings-page-targetlist.js 与 src/proxy.js 均 <800 行，默认配置下既有 effort / usage-scale 测试全绿 — 验证：wc -l + npm test

## 验收标准
- [ ] 未配置 baseUrls 时：enabled=true 全量覆写、enabled=false 字节透传，与归档版 add-effort-override 行为一致
- [ ] baseUrls 配置后：命中上游收到覆写档位、未命中上游 body 与关闭态一致；failover 切换后按实际命中上游的 base 判定
- [ ] 手改 config.json 含非法 URL 项时：非法项丢弃、合法项生效、代理不崩溃
- [ ] 设置页 Effort 区块可增删改目标上游行；非法 URL 本地提示且不提交；保存后回显正确
- [ ] 设置 API 对非法数组（非数组 / 含非字符串 / 不可解析 URL / 非 http(s) 协议）返回 400；usageScale 既有 PATCH 行为不变
- [ ] 全量测试通过；bin/settings-page.js、bin/settings-page-targetlist.js 与 src/proxy.js 均 <800 行