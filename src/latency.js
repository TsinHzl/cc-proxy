// 会话级延迟统计：按请求采集 TTFT（请求到达 → 上游响应头到达）与总耗时
// （请求到达 → 响应结束），进程内聚合 p50/p95 与最慢 Top5，供退出汇总输出。
// 仅存内存，不落盘；容错策略与 usage 一致：非法样本忽略，绝不抛出。
export function createLatencyTracker() {
    const samples = []; // { ttftMs, totalMs, status }

    const sample = ({ ttftMs, totalMs, status } = {}) => {
        if (!Number.isFinite(ttftMs) || ttftMs < 0 || !Number.isFinite(totalMs) || totalMs < 0) return;
        samples.push({ ttftMs, totalMs, status: Number.isInteger(status) ? status : 0 });
    };

    // 最近邻插值分位数：升序排序后取 ceil(p * n) - 1 位（n=1 时即唯一值）。
    const percentile = (values, p) => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
    };

    const summary = () => {
        if (!samples.length) return null;
        const ttft = samples.map((s) => s.ttftMs);
        const total = samples.map((s) => s.totalMs);
        const slowest = [...samples]
            .sort((a, b) => b.totalMs - a.totalMs)
            .slice(0, 5)
            .map((s) => ({ totalMs: s.totalMs, ttftMs: s.ttftMs, status: s.status }));
        return {
            count: samples.length,
            ttftP50: percentile(ttft, 0.5),
            ttftP95: percentile(ttft, 0.95),
            totalP50: percentile(total, 0.5),
            totalP95: percentile(total, 0.95),
            slowest
        };
    };

    return { sample, summary };
}

// 汇总格式化为单行日志文本；无样本返回 null（不输出空行）。
export function formatLatencySummary(s) {
    if (!s || !s.count) return null;
    const slowest = s.slowest
        .map((x) => `${x.totalMs}ms(status ${x.status})`)
        .join(', ');
    return `latency ${s.count} reqs: ttft p50 ${s.ttftP50}ms / p95 ${s.ttftP95}ms, total p50 ${s.totalP50}ms / p95 ${s.totalP95}ms, slowest: ${slowest}`;
}
