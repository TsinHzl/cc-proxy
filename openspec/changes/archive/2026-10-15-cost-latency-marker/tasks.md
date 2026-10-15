# 任务清单：cost-latency-marker

## 状态：DONE

## 任务
- [x] 1. 新建 src/latency.js：createLatencyTracker（sample 容错采集 + summary 分位数/Top5），无样本 summary 返回 null
- [x] 2. 新建 test/latency.test.mjs：采样容错、p50/p95 计算、最慢 Top5 排序、空样本 null
- [x] 3. proxy.js 接入：TTFT/total 采样，覆盖流式与非流式收尾路径，单次防重，拦截/error 路径不采样
- [x] 4. bin/claude-proxy.js 接入：注入 latencyTracker，exit 时 usage 行后追加延迟汇总行
- [x] 5. 新建 test/latency-proxy.test.mjs：proxy 集成验证采样与 summary 输出
- [x] 6. 全量测试通过（node --test --test-timeout=15000）

## 验收标准
- [x] CC_PROXY_LOG=1 时会话退出输出逐会话延迟汇总（count、TTFT p50/p95、total p50/p95、最慢 Top5）
- [x] 默认（无 CC_PROXY_LOG）零输出，代理流量行为不变
- [x] 非正数/非法样本被忽略，无样本时 summary 为 null 不输出
- [x] 全量测试通过
