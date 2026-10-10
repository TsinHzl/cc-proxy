import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/proxy.js';

// Mock upstream：记录收到的请求体，返回最小 SSE 响应。
function startMockUpstream() {
    const state = { bodies: [] };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            state.bodies.push(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            res.end();
        });
    });
    const started = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
    return { state, started };
}

// connection: close：禁用 undici keep-alive，防止连接池 socket 跨测试残留导致进程挂起。
const CC_HEADERS = { 'user-agent': 'claude-cli/2.1', 'content-type': 'application/json', connection: 'close' };

function bodyWithEffort(extra = {}) {
    return JSON.stringify({
        messages: [{ role: 'user', content: '主对话输入' }],
        output_config: { effort: 'low', note: 'keep' },
        effort: 'low',
        ...extra
    });
}

async function startProxy(upstream, options = {}) {
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        ...options
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    return proxy;
}

async function post(port, body, headers = CC_HEADERS) {
    return fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers, body });
}

test('effort override enabled: rewrites both output_config.effort and top-level effort', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, { effortOverride: { enabled: true, level: 'high' } });

    try {
        const res = await post(proxy.address().port, bodyWithEffort());
        await res.text();
        assert.equal(res.status, 200);
        assert.equal(state.bodies.length, 1);
        const forwarded = JSON.parse(state.bodies[0]);
        assert.equal(forwarded.output_config.effort, 'high');
        assert.equal(forwarded.output_config.note, 'keep');
        assert.equal(forwarded.effort, 'high');
        assert.ok(forwarded.messages[0].content.includes('主对话输入'));
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('effort override disabled: body forwarded byte-identical', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, { effortOverride: { enabled: false, level: 'high' } });
    const raw = bodyWithEffort();

    try {
        const res = await post(proxy.address().port, raw);
        await res.text();
        assert.equal(state.bodies.length, 1);
        assert.equal(state.bodies[0], raw);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('effort override honors configured level (medium)', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, { effortOverride: { enabled: true, level: 'medium' } });

    try {
        const res = await post(proxy.address().port, bodyWithEffort());
        await res.text();
        const forwarded = JSON.parse(state.bodies[0]);
        assert.equal(forwarded.output_config.effort, 'medium');
        assert.equal(forwarded.effort, 'medium');
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('non-CC user agent: effort override skipped, verbatim body', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, { effortOverride: { enabled: true, level: 'high' } });
    const raw = bodyWithEffort();

    try {
        const res = await post(proxy.address().port, raw, { 'user-agent': 'curl/8.0', connection: 'close' });
        await res.text();
        assert.equal(state.bodies.length, 1);
        assert.equal(state.bodies[0], raw);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('invalid JSON body: forwarded verbatim even with override enabled', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, { effortOverride: { enabled: true, level: 'high' } });
    const raw = '{"messages": broken';

    try {
        const res = await post(proxy.address().port, raw);
        await res.text();
        assert.equal(state.bodies.length, 1);
        assert.equal(state.bodies[0], raw);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});
