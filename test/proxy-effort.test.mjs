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

// 立即返回 500 的 mock 上游：触发故障转移（无同上游重试）。
async function startFailingUpstream() {
    const server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"type":"error"}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server;
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

test('effort baseUrls targeting: matching primary overridden, non-matching keeps base body', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const port = upstream.address().port;

    try {
        // 命中：配置主上游完整 base → 覆写。
        const hitProxy = await startProxy(upstream, {
            effortOverride: {
                enabled: true, level: 'high',
                baseUrls: [`http://127.0.0.1:${port}`]
            }
        });
        try {
            const res = await post(hitProxy.address().port, bodyWithEffort());
            await res.text();
            const forwarded = JSON.parse(state.bodies[0]);
            assert.equal(forwarded.output_config.effort, 'high');
            assert.equal(forwarded.effort, 'high');
            assert.equal(forwarded.output_config.note, 'keep');
        } finally {
            hitProxy.closeAllConnections?.();
            hitProxy.close();
        }

        // 未命中：配置其他 base → 与「覆写关闭」态一致（保留 CC 本地档位）。
        const raw = bodyWithEffort();
        const missProxy = await startProxy(upstream, {
            effortOverride: {
                enabled: true, level: 'high',
                baseUrls: [`http://127.0.0.1:${port}/other`]
            }
        });
        try {
            const res = await post(missProxy.address().port, raw);
            await res.text();
            assert.equal(state.bodies[1], raw);
        } finally {
            missProxy.closeAllConnections?.();
            missProxy.close();
        }
    } finally {
        upstream.closeAllConnections?.();
        upstream.close();
    }
});

test('effort baseUrls targeting: empty list overrides every upstream (default behavior)', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        effortOverride: { enabled: true, level: 'medium', baseUrls: [] }
    });

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

test('effort baseUrls targeting: failover to matching backup overrides on backup only', async () => {
    const { state, started } = startMockUpstream();
    const backup = await started;
    const failing = await startFailingUpstream();
    const proxy = await startProxy(backup, {
        baseUrlEnv: `http://127.0.0.1:${failing.address().port}`,
        failoverUpstreams: [{
            name: 'backup',
            baseUrl: `http://127.0.0.1:${backup.address().port}`
        }],
        effortOverride: {
            enabled: true, level: 'high',
            // 只配置备用上游 → 主上游不命中（发基准体），failover 后命中。
            baseUrls: [`http://127.0.0.1:${backup.address().port}`]
        }
    });

    try {
        const raw = bodyWithEffort();
        const res = await post(proxy.address().port, raw);
        await res.text();
        // 备用上游收到覆写体；主上游（500 失败路径）不记录 body。
        assert.equal(state.bodies.length, 1);
        const forwarded = JSON.parse(state.bodies[0]);
        assert.equal(forwarded.output_config.effort, 'high');
        assert.equal(forwarded.effort, 'high');
    } finally {
        proxy.closeAllConnections?.();
        failing.closeAllConnections?.();
        backup.closeAllConnections?.();
        proxy.close();
        failing.close();
        backup.close();
    }
});

test('effort baseUrls targeting: failover to non-matching backup sends base body', async () => {
    const { state, started } = startMockUpstream();
    const backup = await started;
    const failing = await startFailingUpstream();
    const proxy = await startProxy(backup, {
        baseUrlEnv: `http://127.0.0.1:${failing.address().port}`,
        failoverUpstreams: [{
            name: 'backup',
            baseUrl: `http://127.0.0.1:${backup.address().port}`
        }],
        effortOverride: {
            enabled: true, level: 'high',
            // 只配置主上游 → failover 后备用不命中 → 收到基准体。
            baseUrls: [`http://127.0.0.1:${failing.address().port}`]
        }
    });

    try {
        const raw = bodyWithEffort();
        const res = await post(proxy.address().port, raw);
        await res.text();
        assert.equal(state.bodies.length, 1);
        assert.equal(state.bodies[0], raw);
    } finally {
        proxy.closeAllConnections?.();
        failing.closeAllConnections?.();
        backup.closeAllConnections?.();
        proxy.close();
        failing.close();
        backup.close();
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
