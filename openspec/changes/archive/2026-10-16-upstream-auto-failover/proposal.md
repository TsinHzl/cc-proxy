# 上游自动故障转移（upstream-auto-failover）

## 状态：DRAFT

## 背景

cc-proxy 已支持多上游静态 failover（`src/upstream.js` 的 `forwardRequestWithRetry` 按 targets 数组顺序切换），并在 observability-and-storage-hardening 中落地了上游健康被动统计（`src/upstream-health.js`）。但现有切换是「盲目顺序」：不感知上游健康度，主上游持续失败时每个请求仍要先撞一次主上游；也没有熔断语义，无法在连续失败后短暂跳过故障上游；健康快照落盘后设置页未展示熔断/恢复状态。

## 目标 / 范围

1. **主优先 + 健康降级选路**：主上游健康（非熔断）时始终优先；主上游被熔断时，按健康分（成功率优先、TTFT p50 次之）在备用上游中选最优，且跳过熔断中的上游。
2. **熔断器（breaker）**：每上游连续失败计数（成功即清零）达到 3 次即熔断（open，跳过该上游，不发请求）；冷却 30s 后进入半开（half-open）——放行 1 个请求探测，成功则恢复（closed），失败重新熔断并重新计时。
3. **全上游熔断兜底**：所有上游（含主）均 open 时，忽略熔断状态按原顺序尝试全部上游，请求不得直接失败——熔断只是选路优化，不是最终否决。
4. **设置页状态徽标**：上游状态卡片现有列追加「熔断中 / 半开探测」状态徽标与冷却剩余时间。

## 技术方案（摘要）

- 新增独立模块 `src/upstream-breaker.js`（design.md 决策 D1）：维护每上游 `{ state: closed|open|half-open, consecutiveFailures, openedAt, cooldownUntil }`，纯内存、无 IO、重启即重置（快照只写不读回，重启后短暂「closed 但显示滞后」属预期）；状态随健康快照一并落盘供设置页读取。
- 接口契约：`createUpstreamBreaker({ failureThreshold = 3, cooldownMs = 30000, now })` → `{ recordSuccess(id), recordFailure(id), probe(id), isOpen(id), getState(id), getSnapshot() }`；`probe(id)` 返回 `{ allowed: boolean, isProbe: boolean }`——冷却已过且当前非并发占用时放行探测（`allowed=true, isProbe=true`），其余情况 `allowed=false`，保证 half-open 期间只放行 1 个探测请求。
- 选路改造点：`src/proxy.js` 每请求构造 targets 时先经 breaker 过滤/排序；`src/upstream.js` `switchToNext` 保持顺序切换兜底，主选路由 proxy.js 完成。全上游 open 时忽略熔断按原顺序尝试（兜底）。
- 快照扩展：`upstream-health.json` 的 upstreams 条目追加 breaker 字段；settings-web 直读展示。
- 参数（3 连败、30s 冷却）为模块常量，不进 config（保持零配置可用）。

## 埋点口径

- 请求内 failover：主上游失败（含连接级失败与状态码失败）计入主上游 breaker 的连续失败计数；随后备用成功同时计入备用 recordSuccess 与主上游「本请求无成功」——不重置主上游计数（只有发往主上游且成功的请求才清零其计数）。
- SSE 响应头已发出后的中途失败：无法 failover，按该上游 recordFailure 计数。
- 判定标准：breaker 的记败口径与现有 `recordFailure({ countRequest })` 对齐——连接级失败补计分母、流中失败不补。

## 预期影响

- 影响文件：`src/proxy.js`、`src/upstream.js`（小改）、`src/upstream-health.js`（快照扩展）、`bin/settings-page.js`（徽标展示）、新增 `src/upstream-breaker.js` + 测试。
- 不改变：thinking→text 改写、非 CC 流量透传、日志静默等关键不变量。

## 风险

- 熔断误判（偶发 3 连败）→ 半开探测 + 冷却自动恢复兜底，最坏情况仅 30s 内少用一个上游。
- 快照结构向后兼容：旧文件缺 breaker 字段时按 closed 处理。
