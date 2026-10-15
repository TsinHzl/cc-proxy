import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLatencyTracker, formatLatencySummary } from '../src/latency.js';

test('sample ignores invalid entries (negative / non-finite / missing)', () => {
    const t = createLatencyTracker();
    t.sample({ ttftMs: -1, totalMs: 100, status: 200 });
    t.sample({ ttftMs: NaN, totalMs: 100, status: 200 });
    t.sample({ ttftMs: 10, totalMs: undefined, status: 200 });
    t.sample();
    t.sample({ ttftMs: 0, totalMs: 0 }); // 0 是合法边界（瞬时响应）
    const s = t.summary();
    assert.equal(s.count, 1);
    assert.equal(s.ttftP50, 0);
    assert.equal(s.totalP50, 0);
});

test('p50/p95 nearest-rank percentiles over multiple samples', () => {
    const t = createLatencyTracker();
    // TTFT: 100..1000 步进 100（10 个样本）；total = ttft + 5000。
    for (let i = 1; i <= 10; i++) {
        t.sample({ ttftMs: i * 100, totalMs: i * 100 + 5000, status: 200 });
    }
    const s = t.summary();
    // 最近邻插值：p50 → ceil(5)-1=第4位(升序 100..1000)=500；
    // p95 → ceil(9.5)-1=第9位=1000。
    assert.equal(s.count, 10);
    assert.equal(s.ttftP50, 500);
    assert.equal(s.ttftP95, 1000);
    assert.equal(s.totalP50, 5500);
    assert.equal(s.totalP95, 6000);
});

test('summary returns null when no samples', () => {
    assert.equal(createLatencyTracker().summary(), null);
    assert.equal(formatLatencySummary(null), null);
});

test('slowest top5 sorted by totalMs descending', () => {
    const t = createLatencyTracker();
    for (const totalMs of [100, 900, 300, 700, 500, 800, 200]) {
        t.sample({ ttftMs: 10, totalMs, status: 200 });
    }
    const s = t.summary();
    assert.deepEqual(s.slowest.map((x) => x.totalMs), [900, 800, 700, 500, 300]);
});

test('formatLatencySummary renders single-line summary', () => {
    const t = createLatencyTracker();
    t.sample({ ttftMs: 120, totalMs: 5000, status: 200 });
    t.sample({ ttftMs: 80, totalMs: 12000, status: 429 });
    const line = formatLatencySummary(t.summary());
    assert.match(line, /latency 2 reqs/);
    // n=2：p50 取升序第 ceil(1)-1=0 位（80），p95 取第 ceil(1.9)-1=1 位（120）。
    assert.match(line, /ttft p50 80ms \/ p95 120ms/);
    assert.match(line, /total p50 5000ms \/ p95 12000ms/);
    assert.match(line, /12000ms\(status 429\)/);
});
