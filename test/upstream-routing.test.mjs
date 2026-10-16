import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/proxy.js';
import { createUpstreamBreaker } from '../src/upstream-breaker.js';
import { createUpstreamHealthTracker } from '../src/upstream-health.js';

// ---------- 桩与辅助 ----------

// Mock upstream：handler 自定义响应行为；记录调用次数。
function startMockUpstream(handler) {
    let calls = 0;
    const server = http.createServer((req, res) => {
        calls += 1;
        handler(req, res);
    });
    server.calls = () => calls;
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function sse(res, body = 'ok') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
}

// 注入桩 tracker + 桩 breaker 的 proxy 集成测试辅助：
// 主上游持续 500 → 备用成功，第 3 次后主上游熔断，第 4 次请求直达备用。
test('primary opens after 3 consecutive failures; later requests skip primary', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('primary-err');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'from-backup'));
    const breaker = createUpstreamBreaker();
    const server = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${primary.address().port}`,
        failoverUpstreams: [{ name: 'backup', baseUrl: `http://127.0.0.1:${backup.address().port}` }],
        upstreamBreaker: breaker,
        upstreamHealth: createUpstreamHealthTracker({ breaker, file: '/dev/null/unused' })
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const send = () => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
        body: '{}'
    });
    try {
        // 第 1-3 次：主上游各尝试 1 次（500 触发故障转移），熔断记败 ×3。
        for (let i = 0; i < 3; i++) {
            const res = await send();
            assert.equal(res.status, 200);
            assert.equal(await res.text(), 'from-backup');
        }
        assert.equal(primary.calls(), 3);
        // 主上游 breaker 键与 proxy 内部一致：labelOf = name || target.host（无 name → host）。
        assert.equal(breaker.getState('127.0.0.1'), 'open');
        // 第 4 次：主上游已 open，不再发请求，直达备用。
        const res4 = await send();
        assert.equal(await res4.text(), 'from-backup');
        assert.equal(primary.calls(), 3);
        assert.equal(backup.calls(), 4);
    } finally {
        server.close();
        primary.close();
        backup.close();
    }
});

// 主上游 open 时备用按健康分排序：成功率低的备用排后。
test('primary open: backups ranked by success rate', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(500);
        res.end();
    });
    // 备用 A：成功率 1/3；备用 B：成功率 3/3 —— B 应排在 A 前。
    let aCalls = 0;
    const backupA = await startMockUpstream((req, res) => {
        aCalls += 1;
        if (aCalls <= 2) { res.writeHead(500); res.end(); return; }
        sse(res, 'from-A');
    });
    const backupB = await startMockUpstream((req, res) => sse(res, 'from-B'));
    const breaker = createUpstreamBreaker();
    // 用桩 tracker 预置样本：A 有 1 次失败，B 全成功。
    const tracker = createUpstreamHealthTracker({ breaker, file: '/dev/null/unused' });
    tracker.recordRequest('A', { ok: false });
    tracker.recordRequest('A', { ok: true, ttftMs: 10 });
    tracker.recordRequest('A', { ok: true, ttftMs: 10 });
    for (let i = 0; i < 3; i++) tracker.recordRequest('B', { ok: true, ttftMs: 100 });

    const server = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${primary.address().port}`,
        failoverUpstreams: [
            { name: 'A', baseUrl: `http://127.0.0.1:${backupA.address().port}` },
            { name: 'B', baseUrl: `http://127.0.0.1:${backupB.address().port}` }
        ],
        upstreamBreaker: breaker,
        upstreamHealth: tracker
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        // 第 1 次请求：主上游 500 → 切 A（500）→ 切 B 成功。同时主上游熔断计数 +1。
        const res1 = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
            body: '{}'
        });
        assert.equal(await res1.text(), 'from-B');
        // 再来 2 次让主上游熔断（共 3 连败）。
        await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
            method: 'POST', headers: { 'user-agent': 'other-client/1.0', 'content-type': 'application/json' }, body: '{}'
        });
        await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
            method: 'POST', headers: { 'user-agent': 'other-client/1.0', 'content-type': 'application/json' }, body: '{}'
        });
        assert.equal(breaker.getState('127.0.0.1'), 'open');
        // 熔断后请求：应按健康分先试 B（成功率 1.0）——B 一次成功，A 不被调用。
        const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
            body: '{}'
        });
        assert.equal(await res.text(), 'from-B');
        const bCallsBefore = 4;
        assert.equal(backupB.calls(), bCallsBefore);
    } finally {
        server.close();
        primary.close();
        backupA.close();
        backupB.close();
    }
});

// 全部上游 open：忽略熔断按原序尝试全部，兜底不直接失败。
test('all open: failover still attempts all upstreams in order', async () => {
    let primaryRecovered = false;
    const primary = await startMockUpstream((req, res) => {
        if (primaryRecovered) { sse(res, 'primary-recovered'); return; }
        res.writeHead(500);
        res.end();
    });
    let backupDown = false;
    const backup = await startMockUpstream((req, res) => {
        if (backupDown) { res.writeHead(500); res.end(); return; }
        sse(res, 'recovered');
    });
    const breaker = createUpstreamBreaker();
    const server = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${primary.address().port}`,
        failoverUpstreams: [{ name: 'backup', baseUrl: `http://127.0.0.1:${backup.address().port}` }],
        upstreamBreaker: breaker,
        upstreamHealth: createUpstreamHealthTracker({ breaker, file: '/dev/null/unused' })
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        // 3 次失败让主上游熔断；备用此时也成功 3 次（closed）。
        for (let i = 0; i < 3; i++) {
            await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
                body: '{}'
            });
        }
        // 强制备用 open 且令其也失败：请求应忽略熔断按原序尝试主+备，主上游恢复后成功。
        breaker.recordFailure('backup');
        breaker.recordFailure('backup');
        breaker.recordFailure('backup');
        assert.equal(breaker.getState('backup'), 'open');
        backupDown = true;
        primaryRecovered = true;
        const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
            body: '{}'
        });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), 'primary-recovered');
        assert.equal(primary.calls(), 4); // 兜底路径仍尝试主上游
        assert.equal(backup.calls(), 4);
    } finally {
        server.close();
        primary.close();
        backup.close();
    }
});

// half-open 探测：冷却后首个请求作为探测发往主上游，成功恢复 closed + 主优先。
test('half-open probe success restores primary', async () => {
    let primaryDown = true;
    const primary = await startMockUpstream((req, res) => {
        if (primaryDown) { res.writeHead(500); res.end(); return; }
        sse(res, 'primary-recovered');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'from-backup'));
    // 短冷却便于测试：100ms。
    const breaker = createUpstreamBreaker({ cooldownMs: 100 });
    const server = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${primary.address().port}`,
        failoverUpstreams: [{ name: 'backup', baseUrl: `http://127.0.0.1:${backup.address().port}` }],
        upstreamBreaker: breaker,
        upstreamHealth: createUpstreamHealthTracker({ breaker, file: '/dev/null/unused' })
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const send = () => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
        body: '{}'
    });
    try {
        for (let i = 0; i < 3; i++) await send();
        assert.equal(breaker.getState('127.0.0.1'), 'open');
        await new Promise((r) => setTimeout(r, 150)); // 冷却过期
        primaryDown = false;
        // 冷却后首个请求 = 探测请求，发往主上游并成功 → closed。
        const res = await send();
        assert.equal(await res.text(), 'primary-recovered');
        assert.equal(breaker.getState('127.0.0.1'), 'closed');
        assert.equal(primary.calls(), 4);
    } finally {
        server.close();
        primary.close();
        backup.close();
    }
});

// half-open 探测失败：重新熔断并重新计时（不发往主上游直到再次冷却过期）。
test('half-open probe failure re-opens breaker', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(500);
        res.end();
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'from-backup'));
    const breaker = createUpstreamBreaker({ cooldownMs: 100 });
    const server = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${primary.address().port}`,
        failoverUpstreams: [{ name: 'backup', baseUrl: `http://127.0.0.1:${backup.address().port}` }],
        upstreamBreaker: breaker,
        upstreamHealth: createUpstreamHealthTracker({ breaker, file: '/dev/null/unused' })
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const send = () => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
        body: '{}'
    });
    try {
        for (let i = 0; i < 3; i++) await send();
        assert.equal(breaker.getState('127.0.0.1'), 'open');
        await new Promise((r) => setTimeout(r, 150));
        // 探测请求：主上游仍 500 → 探测失败 → 重新 open（重新计时）。
        const res = await send();
        assert.equal(await res.text(), 'from-backup');
        assert.equal(breaker.getState('127.0.0.1'), 'open');
        // 重新计时：冷却期内不再探测。
        await send();
        assert.equal(primary.calls(), 4); // 只多了探测那 1 次
    } finally {
        server.close();
        primary.close();
        backup.close();
    }
});
