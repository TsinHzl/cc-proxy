import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/proxy.js';
import { createLatencyTracker, formatLatencySummary } from '../src/latency.js';

// SSE mock upstream：发完整 message 序列，可注入响应前延迟。
function startMockUpstream({ delayMs = 0 } = {}) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
            { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 } } },
            { type: 'message_delta', usage: { output_tokens: 2 } }
        ];
        const write = () => {
            for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
            res.end();
        };
        if (delayMs > 0) setTimeout(write, delayMs); else write();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function sendThrough(proxy, body = '{}') {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
        method: 'POST',
        headers: { 'user-agent': 'claude-cli/2.1', 'content-type': 'application/json' },
        body
    });
    await res.text(); // 消费完整 SSE 流，确保收尾路径执行。
}

test('proxy samples latency for streaming requests, single sample per request', async () => {
    const upstream = await startMockUpstream({ delayMs: 20 });
    const tracker = createLatencyTracker();
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        latencyTracker: tracker
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        await sendThrough(proxy);
        const s = tracker.summary();
        assert.equal(s.count, 1); // 防重标志生效，不因收尾多路径重复采样
        assert.ok(s.ttftP50 >= 20, `ttft should include upstream delay, got ${s.ttftP50}`);
        assert.ok(s.totalP50 >= s.ttftP50);
        assert.equal(s.slowest[0].status, 200);

        const line = formatLatencySummary(s);
        assert.match(line, /latency 1 reqs/);
        assert.match(line, /\(status 200\)/);
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('proxy samples latency for non-streaming JSON responses', async () => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', model: 'claude-opus-5', content: [], usage: {} }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const tracker = createLatencyTracker();
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        latencyTracker: tracker
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        await sendThrough(proxy);
        const s = tracker.summary();
        assert.equal(s.count, 1);
        assert.equal(s.slowest[0].status, 200);
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('non-CC clients are not sampled (verbatim pipe path)', async () => {
    const upstream = await startMockUpstream();
    const tracker = createLatencyTracker();
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        latencyTracker: tracker
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'other-client/1.0', 'content-type': 'application/json' },
            body: '{}'
        });
        await res.text();
        assert.equal(tracker.summary(), null);
    } finally {
        proxy.close();
        upstream.close();
    }
});
