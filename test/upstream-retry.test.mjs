import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { forwardRequestWithRetry } from '../src/upstream.js';

// Mock upstream：按脚本依次返回状态码，之后返回 SSE 200。
// script 项可为数字（状态码）或 { status, body }。
function startMockUpstream(script, finalBody = 'ok') {
    let calls = 0;
    const server = http.createServer((req, res) => {
        calls += 1;
        const step = script.length ? script.shift() : null;
        if (step !== null && step !== undefined) {
            const status = typeof step === 'number' ? step : step.status;
            const body = typeof step === 'object' ? (step.body ?? '') : '';
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(body);
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(finalBody);
    });
    server.calls = () => calls;
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function target(port) {
    return { protocol: 'http:', host: '127.0.0.1', port: String(port), path: '/v1/messages' };
}

function send(port, body = '{}') {
    return new Promise((resolve, reject) => {
        // forwardRequestWithRetry 只读取 req.headers / req.method，用最小桩即可。
        const req = { headers: { 'content-type': 'application/json' }, method: 'POST' };
        forwardRequestWithRetry(req, Buffer.from(body), target(port), (upstreamRes) => {
            const chunks = [];
            upstreamRes.on('data', (c) => chunks.push(c));
            upstreamRes.on('end', () => resolve({ status: upstreamRes.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }, reject);
    });
}

test('retries upstream 503 then succeeds', async () => {
    const upstream = await startMockUpstream([503, 503]);
    try {
        const t0 = Date.now();
        const res = await send(upstream.address().port);
        const elapsed = Date.now() - t0;
        assert.equal(res.status, 200);
        assert.equal(res.body, 'ok');
        assert.equal(upstream.calls(), 3);
        // 两次退避 1s + 2s ≈ 3s，留出裕量。
        assert.ok(elapsed >= 2900, `expected >=2900ms, got ${elapsed}`);
    } finally {
        upstream.close();
    }
});

test('gives up after 3 retries and returns last 503', async () => {
    let calls = 0;
    const always503 = http.createServer((req, res) => {
        calls += 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('overloaded');
    });
    await new Promise((r) => always503.listen(0, '127.0.0.1', r));
    try {
        const res = await send(always503.address().port);
        assert.equal(res.status, 503);
        assert.equal(res.body, 'overloaded');
        assert.equal(calls, 4); // 首次 + 3 次重试
    } finally {
        always503.close();
    }
});

test('does not retry non-retryable status', async () => {
    const upstream = await startMockUpstream([400]);
    try {
        const res = await send(upstream.address().port);
        assert.equal(res.status, 400);
        assert.equal(upstream.calls(), 1);
    } finally {
        upstream.close();
    }
});

test('retries 529 at header stage then succeeds', async () => {
    const upstream = await startMockUpstream([529]);
    try {
        const res = await send(upstream.address().port);
        assert.equal(res.status, 200);
        assert.equal(upstream.calls(), 2);
    } finally {
        upstream.close();
    }
});

test('retries connection-level errors then reports onError', async () => {
    // 先起一个端口占位再关闭，得到一个确定无监听的端口。
    const placeholder = http.createServer();
    await new Promise((r) => placeholder.listen(0, '127.0.0.1', r));
    const deadPort = placeholder.address().port;
    await new Promise((r) => placeholder.close(r));

    let attempts = 0;
    const t0 = Date.now();
    // forwardRequestWithRetry 只读取 req.headers / req.method，用最小桩即可。
    const req = { headers: {}, method: 'POST' };
    const err = await new Promise((resolve) => {
        forwardRequestWithRetry(req, Buffer.from('{}'), target(deadPort), () => {
            resolve(new Error('unexpected respond on dead port'));
        }, resolve, {
            isClientGone: () => { attempts += 1; return false; }
        });
    });
    const elapsed = Date.now() - t0;
    assert.ok(err instanceof Error, `expected error, got ${err}`);
    assert.ok(attempts >= 4, `isClientGone should be consulted each attempt, got ${attempts}`);
    assert.ok(elapsed >= 6900, `expected >=6900ms backoff, got ${elapsed}`);
});
