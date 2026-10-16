# upstream-auto-failover — Design

## 上下文

现有链路：`proxy.js` 每请求构造 `targets = [target, ...failoverBases]`，`upstream.js forwardRequestWithRetry` 顺序切换；`upstream-health.js` 已有被动统计与落盘快照；设置页直读快照文件。

## 目标 / 非目标

**目标**：健康感知选路（主优先 + 备用按健康分）、每上游熔断器（3 连败 / 30s 半开）、设置页徽标。

**非目标**：主动健康探测请求；熔断参数可配置化（保持常量）；权重化流量分配（仅故障场景切换）。

## 决策

### D1 熔断器独立模块 `src/upstream-breaker.js`
纯内存状态机（closed/open/half-open），无 IO；由 proxy.js 在埋点收口处驱动。不并入 upstream-health tracker——tracker 只做被动统计，breaker 是选路决策，职责分离；快照落盘仍由 tracker 统一，breaker 以 `getSnapshot()` 提供字段由 tracker 合入。测试经 `now` 注入时钟，无真实等待。

### D2 选路位置：proxy.js 构造 targets 时，而非 upstream.js switchToNext 内
`switchToNext` 保持顺序切换兜底（同请求内重试场景），主选路在 proxy.js 构造 targets 前完成：breaker 过滤 + 健康分排序。理由：upstream.js 无健康数据依赖，保持其无状态转发职责；proxy.js 已持有 tracker 引用。

### D3 健康分算法（已并入 D6，见 D6 唯一权威定义）



### D4 半开探测语义与并发契约
half-open 状态下放行的「下一个请求」即探测请求，不单独构造探测流量。`probe(id)` 返回 `{ allowed, isProbe }`：冷却已过且无并发探测占用 → `{ allowed: true, isProbe: true }`（进入 half-open）；并发第二个请求 → `{ allowed: false, isProbe: false }`（走备用）；冷却未过 → `{ allowed: false, isProbe: false }`。探测请求的正常成功/失败埋点同时驱动状态迁移（recordSuccess → closed；recordFailure → open 且重新计时）。探测期间其他请求走备用，避免并发探测风暴。

### D5 全熔断兜底
所有上游均 open 时忽略熔断、按原顺序尝试全部上游——熔断是选路优化而非最终否决，代理可用性优先于选路最优性。这也覆盖单上游配置下主上游被熔断的场景。

### D6 健康分算法与空样本规则
成功率（requests 为 0 视为最差、不参与 TTFT 比较）为主键降序；成功率持平（差 <0.01）时 TTFT p50 升序；双方均无 TTFT 样本时保持配置原序（稳定排序）。样本不足（requests < 3）的上游不参与排序优化，按原顺序兜底——避免少量样本误导。

### D7 埋点口径
与现有 `recordFailure({ countRequest })` 对齐：连接级失败（从未收到响应头）补计分母，SSE 流中失败不补。failover 场景：主上游失败计入其连续失败计数；随后备用成功只清零备用自身计数，不重置主上游计数（只有发往主上游且成功的请求才清零）。

### D8 快照兼容与重启语义
upstream-health.json 的 upstreams 条目追加 `breaker: { state, consecutiveFailures, cooldownUntil }`；`readHealthSnapshot` 缺失/非法字段 → closed。旧文件、旧版本代理写出的文件均无需迁移。breaker 为纯内存、重启即重置——快照只写不读回，重启后设置页可能短暂展示滞后（旧快照）但实际状态为 closed，属预期，不算 bug。

## 风险与权衡

- **误熔断**（偶发 3 连败，如网络抖动）：代价仅为 30s 内该上游不被选中，半开探测自动恢复，可接受。
- **健康分与静态顺序的偏差**：备用上游一旦被选中，请求内重试仍按 targets 顺序回退，行为可预测。
- **设置页数据滞后**：快照 500ms 防抖落盘，徽标最多滞后约 1s，可接受。

## 迁移

无数据迁移、无配置变更、无接口签名破坏。`failoverUpstreams` 配置语义不变。

## Open Questions

无（三项关键决策已在阶段 0 与用户确认）。
