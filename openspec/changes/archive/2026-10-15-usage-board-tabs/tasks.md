# 任务清单：usage-board-tabs

## 状态：ARCHIVED

## 任务
- [x] 1. 后端：`bin/settings-web.js` 中 `buildUsageReport` 的 `readRecentDays(defaultUsagePath(), 7)` 改为 30 天，注释同步更新为「近 30 天明细，前端按 Tab 切片」；验证：`node --check bin/settings-web.js` 且现有测试全绿
- [x] 2. 前端聚合：`bin/settings-page.js` 内联脚本新增 Tab 状态（`RANGES`/`currentRange`，默认今日）、Tab 条 DOM 渲染与点击切换重渲染、区间聚合函数（切片求和 + byModel 跨天合并 + hitRate 重算 + 费用可估才求和）；验证：`node --check`（经 renderSettingsPage 输出侧校验脚本语法）
- [x] 3. 前端渲染：`renderUsageBoard` 按 `currentRange` 切片——今日=单日柱+今日汇总/模型表（与现状一致）；七天/一个月=N 日柱+区间合计汇总/模型表；柱状图 alert 红柱仍只标今日；新增 `.usage-tabs`/`.usage-tab` CSS；验证：全量测试绿 + 手动核对三种 Tab 渲染
- [x] 4. 测试与回归：为 `/api/usage` 30 天响应形状补/改 node:test 断言；跑 `node --test --test-timeout=15000 "test/"*.test.mjs` 全量回归 fail 0

## 验收标准
- [x] 看板出现「今日 / 七天 / 一个月」三个 Tab，点击即切换，当前 Tab 视觉高亮
- [x] 今日 Tab 的柱状图、汇总行、按模型表与改造前「近 7 天」版面的今日内容一致（零回归）
- [x] 七天 Tab：7 根柱 + 近 7 天合计汇总行 + 模型跨天合并表
- [x] 一个月 Tab：30 根柱（数据不足 30 天时按实际天数展示）+ 30 天合计
- [x] 告警红点/红柱行为不变（仍只针对今日超阈值）
- [x] `node --test --test-timeout=15000 "test/"*.test.mjs` 全量 fail 0
