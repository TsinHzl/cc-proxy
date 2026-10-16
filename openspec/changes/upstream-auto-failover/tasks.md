# tasks.md — upstream-auto-failover

## 状态：IN_PROGRESS

## 任务

### T1 熔断器模块与测试
- [x] 新增 `src/upstream-breaker.js`：`createUpstreamBreaker({ failureThreshold = 3, cooldownMs = 30000, now })` → `{ recordSuccess(id), recordFailure(id), probe(id), isOpen(id), getState(id), getSnapshot() }`；状态机 closed →（连续失败≥3，成功清零）→ open（跳过）→ 30s 后 → half-open → 成功 closed / 失败 open（重新计时）
- [x] `probe(id)` 契约：返回 `{ allowed, isProbe }`；冷却已过且无并发探测占用时返回 `{ allowed: true, isProbe: true }` 并进入 half-open；并发第二个请求返回 `{ allowed: false, isProbe: false }`；冷却未过返回 `{ allowed: false, isProbe: false }`
- [x] 新增 `test/upstream-breaker.test.mjs`：熔断触发、成功清零、冷却期内跳过、半开放行与并发拒绝、探测成功恢复、探测失败重新熔断重新计时、时钟注入
- 验证方式：`node --test --test-timeout=15000 test/upstream-breaker.test.mjs` 通过

### T2 快照扩展与健康 tracker 集成
- [ ] `src/upstream-health.js`：接受注入的 breaker，快照 upstreams 条目追加 `{ breaker: { state, consecutiveFailures, cooldownRemainingMs } }`；`readHealthSnapshot` 对缺失/非法字段容错为 closed
- [ ] 扩展/新增测试：快照含 breaker 字段、旧快照文件兼容
- 验证方式：`node --test --test-timeout=15000 test/upstream-health.test.mjs` 通过

### T3 选路接入（主优先 + 健康降级 + 全熔断兜底）
- [ ] `src/proxy.js`：每请求构造 targets 前经 breaker 过滤——主上游非 open 时 targets 仍以主上游开头；主上游 open 时按健康分对备用排序（成功率降序为主键，requests===0 或成功率差 <0.01 时按 TTFT p50 升序；无样本上游不参与排序、按原序兜底），取首个非 open 上游为首选；**全部上游均 open 时忽略熔断、按原顺序尝试全部（熔断不是最终否决）**
- [ ] 健康分规则：TTFT 用 p50；requests 为 0 或样本不足（requests < 3）视为最差、不参与排序优化、按原序兜底；成功率持平（差 <0.01）时再比 TTFT p50
- [ ] 埋点接线：转发成功/失败处调用 breaker recordSuccess/recordFailure，口径与 proposal「埋点口径」一致（连接级失败补计分母、流中失败不补；failover 后备用成功不重置主上游计数）；half-open 探测请求的成功/失败驱动状态迁移；全熔断兜底请求成功时同样调用 recordSuccess 关闭对应上游熔断
- [ ] 更新/新增 proxy 选路测试（注入桩 tracker + breaker）
- 验证方式：相关测试通过；`node --test --test-timeout=15000 "test/"*.test.mjs` 全绿

### T4 设置页状态徽标
- [ ] `bin/settings-page.js`：上游状态卡片追加状态徽标——closed 不展示、open 展示「熔断中」+ 冷却剩余秒数、half-open 展示「半开探测」
- [ ] 更新设置页相关测试（快照注入）
- 验证方式：设置页测试通过；手动 `cc-proxy --setting` 目视确认

### T5 文档与归档准备
- [ ] README/CLAUDE.md 架构图补 upstream-breaker 一行
- [ ] tasks.md 全部勾选后走归档流程

## 验收标准

1. 主上游连续失败 3 次后被熔断，后续请求不再发往主上游（不发探测请求）
2. 冷却 30s 后下一个请求作为半开探测发往主上游：成功 → 恢复主优先；失败 → 重新熔断 30s
3. 主上游熔断期间，备用选择按健康分排序：成功率降序为主键，成功率持平（差 <0.01）时按 TTFT p50 升序；无样本或样本不足（requests < 3）上游不参与排序、按原序兜底
4. 设置页展示「熔断中（剩余 Xs）/ 半开探测」徽标
5. 旧 upstream-health.json（无 breaker 字段）读取不报错，按 closed 处理
6. 全部上游均 open 时请求不直接失败，按原顺序尝试全部上游
7. 全量测试通过
