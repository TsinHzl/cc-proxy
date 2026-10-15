# 变更提案：usage-board-tabs

## 背景
设置页用量看板当前固定展示「近 7 天」柱状图与今日汇总行/按模型表，无法切换查看今日或近一个月（30 天）口径。用户需要三种时间维度（今日 / 七天 / 一个月）可通过 Tab 切换。

视觉基准：看板沿用需求截图所示现有版式（按日柱状图、汇总行、按模型表），不改动截图中的既有视觉细节，仅新增 Tab 条。

## 目标范围
**在范围内：**
- 看板标题区新增三个 Tab（今日 / 七天 / 一个月），点击切换，当前 Tab 高亮
- 后端 `/api/usage` 改为返回近 30 天明细（`readRecentDays(…, 30)`），告警字段（dailyTokens/exceeded）语义不变，仍按今日判断
- 前端按当前 Tab 切片渲染：
  - 今日：柱状图为单日柱（沿用现有逻辑取 1 天），汇总行与按模型表均为今日数据（与现状一致）
  - 七天：柱状图 7 天；汇总行与按模型表为 7 天区间合计（requests/tokens 逐项求和、命中率按合计 token 重算、费用可估才求和）
  - 一个月：柱状图 30 天；汇总行与按模型表为 30 天区间合计（同上）
- 区间合计的按模型表：同名模型跨天合并（逐字段相加）

**不在范围内：**
- usage.json 数据结构与落盘逻辑不变
- 告警阈值行为不变（仍只针对今日）
- 不新增设置项、不改 CLI

## 技术方案
- `bin/settings-web.js`：`buildUsageReport` 中 `readRecentDays` 的 7 改为 30，days 数组自然含 30 项；其余响应形状不变（前端按需切片）
- `bin/settings-page.js`（内联脚本，禁用反引号模板字面量）：
  - 新增 `RANGES = [{key:'today',label:'今日',days:1},{key:'week',label:'七天',days:7},{key:'month',label:'一个月',days:30}]` 与模块级 `currentRange` 状态，默认 `today`（保持首屏与现状一致）
  - Tab 条 DOM 渲染 + 点击切换重渲染（数据已在前端内存，无需重新请求）
  - 新增区间聚合函数：切片求和生成聚合 day（date 取区间描述文本），`byModel` 跨天合并；hitRate 用合计 cacheRead/(cacheRead+input+cacheCreation) 重算
  - `renderUsageBoard` 按 `currentRange` 切片渲染；柱状图 alert 红柱仍只标今日
- CSS：新增 `.usage-tabs` / `.usage-tab`（含激活态）样式，风格沿用现有 card 变量

## 预期影响
- API 响应体积由 7 项增为 30 项（本地回环，量级可忽略）
- 默认 Tab「今日」首屏渲染与现状完全一致，零行为回归
- 非 CC 流量与其他设置页功能不受影响

## 风险
- 30 天数据中损坏/缺失日：`readRecentDays` 已回退空统计，无需额外处理
- 聚合函数遗漏字段导致汇总不准：用 node:test 对聚合逻辑所在可测部分覆盖；前端聚合通过手动验证三种 Tab
