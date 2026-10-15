# 变更提案：cost-latency-marker

## 背景
cc-proxy 已有按天/按模型的 token 用量统计（usage.json + 退出汇总），但缺少延迟维度。排查上游网关慢、思考耗时长等问题时，用户只能靠 CC_PROXY_DEBUG 逐请求翻日志。需要一个会话级的延迟汇总：退出时一次性输出逐请求 TTFT（首字节耗时）与总耗时，并给出 p50/p95 与最慢请求列表。

## 用户澄清结论（阶段 0）
- 仅做**延迟侧**：退出时逐请求延迟汇总（TTFT + 总耗时、p50/p95、最慢请求列表），经 logger 静默输出（CC_PROXY_LOG=1 可见）。
- **费用侧维持现状**：不新增费用计算。

## 目标范围
**在范围内：**
- proxy.js 采集每条 CC UA message 请求的延迟样本：TTFT（请求到达 → 上游响应首事件）与总耗时（请求到达 → 响应结束）。
- 进程内聚合：保留全部样本的 TTFT/total 数组，计算 p50/p95，维护最慢 Top 5（按 total 降序，记录状态码与耗时）。
- bin/claude-proxy.js child.on('exit') 处，在现有 usage 汇总行之后追加一条延迟汇总行（logger.warn，默认静默）。
- 单元测试覆盖样本采集、分位数计算、Top N 排序与汇总输出。

**不在范围内：**
- 费用计算、落盘持久化（延迟样本仅存内存，会话级）。
- 非 CC UA 流量、Suggestion Mode 拦截请求（零上游消耗路径）。
- 设置页 UI 展示。

## 技术方案
- 新建 `src/latency.js`：`createLatencyTracker()` 返回 `{ sample, summary }`；`sample({ ttftMs, totalMs, status })` 容错采集（非正数忽略）；`summary()` 返回 `{ count, ttftP50, ttftP95, totalP50, totalP95, slowest: [...] }`，无样本返回 null（不输出空行）。分位数用最近邻插值排序取值，无需引入依赖。
- proxy.js：在 `requestStartedAt` 锚点已有基础上，流式与非流式两条收尾路径调用 `latencyTracker.sample()`，TTFT 取上游响应头到达时刻（`respond` 回调入口）与请求到达时刻之差；Suggestion Mode 拦截与 upstream error（未收到响应头）路径不采样。
- bin/claude-proxy.js：createProxy 注入 `latencyTracker`；exit 回调中在 usage 汇总行后追加 `latency p50/p95` 输出行。

## 预期影响
- 默认行为零变化（logger 静默）。CC_PROXY_LOG=1 时退出多一行延迟汇总。
- 内存开销：每请求两个数字 + Top 5 数组，可忽略。
- 不触碰 thinking→text 渲染、透传不变量与设置页安全链。

## 风险
- 多条收尾路径（正常结束/上游错误/客户端断开）可能重复采样 → 用 res/request 生命周期单次标志防重。
- 上游 failover 重试期间 TTFT 含重试耗时 → 记录为该请求的真实首字节体验，符合用户感知口径，文档注明。
