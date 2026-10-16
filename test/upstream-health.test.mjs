import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
    createUpstreamHealthTracker,
    readHealthSnapshot,
    defaultHealthPath
} from '../src/upstream-health.js';
import { createProxyServer } from '../src/proxy.js';

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-health-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// Mock upstream：handler 自定义响应行为（与 upstream-failover.test.mjs 同款）。
function startMockUpstream(handler) {
    const server = http.createServer((req, res) => handler(req, res));
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function sse(res, body = 'ok') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
}

// ---------- 记录与快照 ----------

test('recordRequest: counts requests/failures and keeps last 500 ttft samples', () => {
    const t = createUpstreamHealthTracker({ file: path.join('/dev/null', 'unused') });
    t.recordRequest('api.anthropic.com', { ok: true, ttftMs: 100 });
    t.recordRequest('api.anthropic.com', { ok: true, ttftMs: 200 });
    t.recordRequest('api.anthropic.com', { ok: false });
    t.recordRequest('gw.example.com', { ok: true, ttftMs: 50 });
    // 非法 id 与非法 ttft 忽略，不计入。
    t.recordRequest('', { ok: true, ttftMs: 1 });
    t.recordRequest(null, { ok: true });
    t.recordRequest('api.anthropic.com', { ok: true, ttftMs: -5 });
    t.recordRequest('api.anthropic.com', { ok: true, ttftMs: NaN });

    const snap = t.getHealthSnapshot();
    const primary = snap.upstreams.find((u) => u.id === 'api.anthropic.com');
    // 非法 ttft（-5/NaN）仍计请求数（请求确实发生），仅不进 ttft 样本。
    assert.equal(primary.requests, 5);
    assert.equal(primary.failures, 1);
    assert.equal(primary.samples, 2);
    const backup = snap.upstreams.find((u) => u.id === 'gw.example.com');
    assert.equal(backup.requests, 1);
});

test('recordRequest: ttfts ring buffer trims beyond 500 samples', () => {
    const t = createUpstreamHealthTracker({ file: path.join('/dev/null', 'unused') });
    for (let i = 0; i < 505; i++) {
        t.recordRequest('up', { ok: true, ttftMs: i });
    }
    const snap = t.getHealthSnapshot();
    assert.equal(snap.upstreams[0].samples, 500);
    // 裁剪掉最旧 5 个样本：剩余 [5..504]，p50 = 第 250 位 = 254，p95 = 第 475 位 = 479。
    assert.equal(snap.upstreams[0].ttftP50, 254);
    assert.equal(snap.upstreams[0].ttftP95, 479);
});

test('percentile: known samples produce nearest-rank p50/p95', () => {
    const t = createUpstreamHealthTracker({ file: path.join('/dev/null', 'unused') });
    for (const ms of [10, 20, 30, 40, 100]) {
        t.recordRequest('up', { ok: true, ttftMs: ms });
    }
    const [up] = t.getHealthSnapshot().upstreams;
    // 升序 [10,20,30,40,100]：p50 = ceil(0.5*5)=3 → 第 3 位 = 30；p95 = ceil(4.75)=5 → 100。
    assert.equal(up.ttftP50, 30);
    assert.equal(up.ttftP95, 100);
    // 无样本上游：分位数为 null。
    const empty = createUpstreamHealthTracker({ file: path.join('/dev/null', 'unused') });
    empty.recordRequest('up', { ok: true });
    assert.equal(empty.getHealthSnapshot().upstreams[0].ttftP50, null);
});

test('recordFailover: ring buffer keeps last 20 events with time/from/to/reason', () => {
    let tick = 0;
    const t = createUpstreamHealthTracker({
        file: path.join('/dev/null', 'unused'),
        now: () => new Date(1700000000000 + (tick++) * 1000)
    });
    for (let i = 0; i < 25; i++) {
        t.recordFailover(`up-${i}`, `up-${i + 1}`, `HTTP 429`);
    }
    t.recordFailover('a', null); // 非法 to 忽略
    t.recordFailover(null, 'b'); // 非法 from 忽略
    const snap = t.getHealthSnapshot();
    assert.equal(snap.failovers.length, 20);
    assert.equal(snap.failovers[0].from, 'up-5'); // 最旧保留的是第 6 条
    assert.equal(snap.failovers[19].to, 'up-25');
    assert.match(snap.failovers[19].time, /^2023-11-14T22:13/);
    assert.equal(snap.failovers[19].reason, 'HTTP 429');
    // 非字符串 reason 归 'unknown'。
    t.recordFailover('x', 'y', 42);
    assert.equal(t.getHealthSnapshot().failovers.at(-1).reason, 'unknown');
});

test('recordFailure: adds failure without double-counting requests', () => {
    const t = createUpstreamHealthTracker({ file: path.join('/dev/null', 'unused') });
    t.recordRequest('up', { ok: true, ttftMs: 10 });
    t.recordFailure('up');
    t.recordFailure('up');
    t.recordFailure(''); // 非法 id 忽略
    const snap = t.getHealthSnapshot();
    assert.equal(snap.upstreams[0].requests, 1);
    assert.equal(snap.upstreams[0].failures, 2);
});

// ---------- 落盘与读回 ----------

test('flush: debounced write via tmp+rename, mode 0600, readHealthSnapshot roundtrip', async (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'runtime', 'upstream-health.json');
    const tracker = createUpstreamHealthTracker({ file, debounceMs: 10 });
    tracker.recordRequest('api.anthropic.com', { ok: true, ttftMs: 42 });
    tracker.recordFailover('a', 'b', 'HTTP 503');
    // 防抖窗口内文件尚未写出。
    assert.equal(fs.existsSync(file), false);
    // 轮询等待防抖落盘，避免慢机器上固定 sleep 不足导致 flaky。
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) {
        await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(fs.existsSync(file), true);
    // 目录内无残留 tmp 文件（rename 原子替换）。
    const leftovers = fs.readdirSync(path.join(dir, 'runtime')).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const snap = readHealthSnapshot(file);
    assert.equal(snap.upstreams[0].id, 'api.anthropic.com');
    assert.equal(snap.upstreams[0].requests, 1);
    assert.equal(snap.upstreams[0].ttftP50, 42);
    assert.equal(snap.failovers.length, 1);
    assert.equal(snap.failovers[0].reason, 'HTTP 503');
});

test('flushNow: synchronous final flush, clears pending debounce timer', async (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'upstream-health.json');
    const tracker = createUpstreamHealthTracker({ file, debounceMs: 10_000 });
    tracker.recordRequest('up', { ok: true, ttftMs: 7 });
    // 防抖未到期，手动 flush 立即落盘。
    tracker.flushNow();
    assert.equal(readHealthSnapshot(file).upstreams[0].requests, 1);
    // flush 后防抖到期不再重复写（定时器已清）：等待远超 debounce 周期后
    // mtime 不变（无第二次写入）。
    await new Promise((r) => setTimeout(r, 30));
    const mtimeAfterFlush = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.statSync(file).mtimeMs, mtimeAfterFlush);
});

test('flushNow: renameSync failure cleans up leftover tmp file', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'upstream-health.json');
    const tracker = createUpstreamHealthTracker({ file, debounceMs: 10_000 });
    tracker.recordRequest('up', { ok: true, ttftMs: 7 });
    // 目标路径是目录 → renameSync 必失败；tmp 应被清理而非残留。
    fs.mkdirSync(file);
    tracker.flushNow();
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, []);
});

test('readHealthSnapshot: missing/corrupt/invalid file returns empty snapshot', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'health.json');
    // 缺失。
    assert.deepEqual(readHealthSnapshot(file), { updatedAt: null, upstreams: [], failovers: [] });
    // 损坏。
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(readHealthSnapshot(file), { updatedAt: null, upstreams: [], failovers: [] });
    // 结构非法：非对象/数组/条目缺 id。
    fs.writeFileSync(file, '[1,2]');
    assert.deepEqual(readHealthSnapshot(file), { updatedAt: null, upstreams: [], failovers: [] });
    fs.writeFileSync(file, JSON.stringify({ upstreams: [null, 'x', { requests: 1 }], failovers: ['bad'] }));
    const snap = readHealthSnapshot(file);
    assert.deepEqual(snap.upstreams, []);
    assert.deepEqual(snap.failovers, []);
    // defaultHealthPath 注入 envDir 与默认值形态。
    assert.equal(defaultHealthPath(dir), path.join(dir, 'runtime', 'upstream-health.json'));
    assert.match(defaultHealthPath(), /\.cc-proxy[/\\]runtime[/\\]upstream-health\.json$/);
});

// ---------- proxy 集成 ----------

test('proxy integration: failover event recorded and samples attributed to backup upstream', async (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'upstream-health.json');
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('rate-limited');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'ok-backup'));
    try {
        const health = createUpstreamHealthTracker({ file, debounceMs: 5 });
        const proxy = createProxyServer({
            baseUrlEnv: `http://127.0.0.1:${primary.address().port}`,
            upstreamHealth: health,
            failoverUpstreams: [{ name: 'backup', baseUrl: `http://127.0.0.1:${backup.address().port}` }]
        });
        await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
        try {
            const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
                method: 'POST',
                headers: { 'user-agent': 'claude-cli/1.0.0 (external, cli)', 'content-type': 'application/json' },
                body: '{"model":"claude-sonnet-5","max_tokens":1,"messages":[]}'
            });
            await res.text();
            assert.equal(res.status, 200);
            // 埋点为同步内存操作：无需等防抖即可断言快照。
            const snap = health.getHealthSnapshot();
            // 备用上游有 name → id 为 'backup'；成功交付 1 次且无失败。
            const backupEntry = snap.upstreams.find((u) => u.id === 'backup');
            assert.ok(backupEntry, `backup upstream should be tracked, got: ${JSON.stringify(snap.upstreams)}`);
            assert.equal(backupEntry.requests, 1);
            assert.equal(backupEntry.failures, 0);
            assert.ok(backupEntry.ttftP50 >= 0);
            // 切换事件：主上游 127.0.0.1 → backup，原因 HTTP 429。
            assert.equal(snap.failovers.length, 1);
            assert.equal(snap.failovers[0].from, '127.0.0.1');
            assert.equal(snap.failovers[0].to, 'backup');
            assert.equal(snap.failovers[0].reason, 'HTTP 429');
            // 主上游 429 未交付（触发切换）→ 不记成功样本；其故障由切换事件体现。
            assert.equal(snap.upstreams.length, 1);
        } finally {
            await new Promise((r) => proxy.close(r));
        }
    } finally {
        primary.close();
        backup.close();
    }
});
