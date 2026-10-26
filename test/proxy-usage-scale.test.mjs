import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/proxy.js';

// Mock upstream：按调用方给的 events 序列回放 SSE（带 usage 的事件），
// 或返回非流式 JSON。记录收到的请求体。
function startMockUpstream({ events = [], json = null } = {}) {
    const state = { bodies: [] };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            state.bodies.push(Buffer.concat(chunks).toString('utf8'));
            if (json) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(json));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const event of events) {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
        });
    });
    const started = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
    return { state, started };
}

// 立即返回 500 的 mock 上游：用于触发 failover（无同上游重试）。
async function startFailingUpstream() {
    const failing = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"type":"error"}');
        });
    });
    await new Promise((r) => failing.listen(0, '127.0.0.1', r));
    return failing;
}

// connection: close：禁用 undici keep-alive，防止连接池 socket 跨测试残留导致进程挂起。
const CC_HEADERS = { 'user-agent': 'claude-cli/2.1', 'content-type': 'application/json', connection: 'close' };
const OTHER_HEADERS = { ...CC_HEADERS, 'user-agent': 'other-client/1.0' };

// 含 usage 的最小 SSE 事件序列：message_start 带全量 input 类字段，
// message_delta 只带 output_tokens（Anthropic 语义）。
const SSE_EVENTS = [
    { type: 'message_start', message: { model: 'claude-sonnet-5', usage: {
        input_tokens: 1000, cache_creation_input_tokens: 40, cache_read_input_tokens: 200,
        output_tokens: 1
    } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 555 } },
    { type: 'message_stop' }
];

async function startProxy(upstream, options = {}) {
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        ...options
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    return proxy;
}

async function post(port, headers = CC_HEADERS) {
    return fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers, body: '{}'
    });
}

// 解析客户端收到的 SSE 流为事件对象数组。
async function readSseEvents(res) {
    const text = await res.text();
    const events = [];
    for (const block of text.split('\n\n')) {
        const dataLines = block.split('\n').filter((l) => l.startsWith('data:'));
        if (!dataLines.length) continue;
        events.push(JSON.parse(dataLines.map((l) => l.slice(5).trimStart()).join('\n')));
    }
    return events;
}

test('usage scale enabled: SSE input-class fields scaled, output untouched, internal stats real', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const recorded = [];
    const proxy = await startProxy(upstream, {
        usageScale: { enabled: true, ratio: 0.5 },
        usageTracker: { record: (usage, model) => recorded.push({ usage, model }) }
    });

    try {
        const res = await post(proxy.address().port);
        assert.equal(res.status, 200);
        const events = await readSseEvents(res);
        const start = events.find((e) => e.type === 'message_start');
        const delta = events.find((e) => e.type === 'message_delta');
        assert.equal(start.message.usage.input_tokens, 500);
        assert.equal(start.message.usage.cache_creation_input_tokens, 20);
        assert.equal(start.message.usage.cache_read_input_tokens, 100);
        assert.equal(start.message.usage.output_tokens, 1);
        assert.equal(delta.usage.output_tokens, 555);
        // 内部统计：真实值（缩放前）。
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].usage.inputTokens, 1000);
        assert.equal(recorded[0].usage.cacheReadTokens, 200);
        assert.equal(recorded[0].usage.outputTokens, 555);
        assert.equal(recorded[0].model, 'claude-sonnet-5');
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('usage scale enabled with ratio 2: input fields amplified', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        usageScale: { enabled: true, ratio: 2 }
    });

    try {
        const res = await post(proxy.address().port);
        const events = await readSseEvents(res);
        const start = events.find((e) => e.type === 'message_start');
        assert.equal(start.message.usage.input_tokens, 2000);
        assert.equal(start.message.usage.cache_read_input_tokens, 400);
        assert.equal(start.message.usage.output_tokens, 1);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('usage scale disabled (enabled=false, ratio≠1): passthrough byte-identical usage', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        usageScale: { enabled: false, ratio: 0.5 }
    });

    try {
        const res = await post(proxy.address().port);
        const events = await readSseEvents(res);
        const start = events.find((e) => e.type === 'message_start');
        // 关闭态：上游是多少就是多少。
        assert.equal(start.message.usage.input_tokens, 1000);
        assert.equal(start.message.usage.cache_read_input_tokens, 200);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('usage scale null / ratio=1: no rewriting at all', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const proxy = await startProxy(upstream, { usageScale: null });

    try {
        const res = await post(proxy.address().port);
        const events = await readSseEvents(res);
        const start = events.find((e) => e.type === 'message_start');
        assert.equal(start.message.usage.input_tokens, 1000);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('usage scale: non-CC UA traffic untouched', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        usageScale: { enabled: true, ratio: 0.5 }
    });

    try {
        const res = await post(proxy.address().port, OTHER_HEADERS);
        const text = await res.text();
        // 非 CC UA：SSE 原样透传，usage 字段保持上游原值。
        assert.ok(text.includes('"input_tokens":1000'));
        assert.ok(!text.includes('"input_tokens":500'));
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('usage scale enabled: non-streaming message JSON usage scaled, output kept', async () => {
    const { started } = startMockUpstream({
        json: {
            type: 'message',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 555 }
        }
    });
    const upstream = await started;
    const recorded = [];
    const proxy = await startProxy(upstream, {
        usageScale: { enabled: true, ratio: 0.5 },
        usageTracker: { record: (usage, model) => recorded.push({ usage, model }) }
    });

    try {
        const res = await post(proxy.address().port);
        const body = JSON.parse(await res.text());
        assert.equal(body.usage.input_tokens, 500);
        assert.equal(body.usage.cache_read_input_tokens, 100);
        assert.equal(body.usage.output_tokens, 555);
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].usage.inputTokens, 1000);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

// ---------- 定向缩放（usageScale.baseUrls） ----------

test('baseUrls targeting: primary hit scaled, non-hit passthrough', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const port = upstream.address().port;

    try {
        // 命中：配置主上游完整 base。
        const hitProxy = await startProxy(upstream, {
            usageScale: { enabled: true, ratio: 0.5, baseUrls: [`http://127.0.0.1:${port}`] }
        });
        try {
            const res = await post(hitProxy.address().port);
            const events = await readSseEvents(res);
            const start = events.find((e) => e.type === 'message_start');
            assert.equal(start.message.usage.input_tokens, 500);
        } finally {
            hitProxy.closeAllConnections?.();
            hitProxy.close();
        }

        // 未命中：配置另一个 base → 1:1 透传。
        const missProxy = await startProxy(upstream, {
            usageScale: { enabled: true, ratio: 0.5, baseUrls: ['http://127.0.0.1:1'] }
        });
        try {
            const res = await post(missProxy.address().port);
            const events = await readSseEvents(res);
            const start = events.find((e) => e.type === 'message_start');
            assert.equal(start.message.usage.input_tokens, 1000);
            assert.equal(start.message.usage.cache_read_input_tokens, 200);
        } finally {
            missProxy.closeAllConnections?.();
            missProxy.close();
        }
    } finally {
        upstream.closeAllConnections?.();
        upstream.close();
    }
});

test('baseUrls targeting: path prefix of primary base honored', async () => {
    // 主上游 base 带路径前缀 /gw；配置 /gw 命中，配置 /other 不命中。
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const port = upstream.address().port;
    const proxy = await startProxy(upstream, {
        baseUrlEnv: `http://127.0.0.1:${port}/gw`,
        usageScale: { enabled: true, ratio: 0.5, baseUrls: [`http://127.0.0.1:${port}/gw`] }
    });
    try {
        const res = await post(proxy.address().port);
        const events = await readSseEvents(res);
        const start = events.find((e) => e.type === 'message_start');
        assert.equal(start.message.usage.input_tokens, 500);
    } finally {
        proxy.closeAllConnections?.();
        proxy.close();
        upstream.closeAllConnections?.();
        upstream.close();
    }
});

test('baseUrls targeting: failover to matching backup scales, non-matching passes through', async () => {
    // 主上游 500（立即故障转移，无同上游重试），备用上游回放 SSE。
    const backup = await startMockUpstream({ events: SSE_EVENTS });
    const backupServer = await backup.started;
    const failing = await startFailingUpstream();

    const proxy = await startProxy(backupServer, {
        baseUrlEnv: `http://127.0.0.1:${failing.address().port}`,
        failoverUpstreams: [{
            name: 'backup',
            baseUrl: `http://127.0.0.1:${backupServer.address().port}`
        }],
        usageScale: {
            enabled: true,
            ratio: 0.5,
            // 只配置备用上游 → 主上游不命中，failover 后命中。
            baseUrls: [`http://127.0.0.1:${backupServer.address().port}`]
        }
    });
    try {
        const res = await post(proxy.address().port);
        const events = await readSseEvents(res);
        const start = events.find((e) => e.type === 'message_start');
        // failover 后按实际命中（备用）判定 → 缩放。
        assert.equal(start.message.usage.input_tokens, 500);
    } finally {
        proxy.closeAllConnections?.();
        proxy.close();
        failing.closeAllConnections?.();
        failing.close();
        backupServer.closeAllConnections?.();
        backupServer.close();
    }
});

test('baseUrls targeting: failover to non-matching backup passes through', async () => {
    const backup = await startMockUpstream({ events: SSE_EVENTS });
    const backupServer = await backup.started;
    const failing = await startFailingUpstream();

    const proxy = await startProxy(backupServer, {
        baseUrlEnv: `http://127.0.0.1:${failing.address().port}`,
        failoverUpstreams: [{
            name: 'backup',
            baseUrl: `http://127.0.0.1:${backupServer.address().port}`
        }],
        usageScale: {
            enabled: true,
            ratio: 0.5,
            // 只配置主上游 → failover 后备用不命中 → 1:1 透传。
            baseUrls: [`http://127.0.0.1:${failing.address().port}`]
        }
    });
    try {
        const res = await post(proxy.address().port);
        const events = await readSseEvents(res);
        const start = events.find((e) => e.type === 'message_start');
        assert.equal(start.message.usage.input_tokens, 1000);
    } finally {
        proxy.closeAllConnections?.();
        proxy.close();
        failing.closeAllConnections?.();
        failing.close();
        backupServer.closeAllConnections?.();
        backupServer.close();
    }
});

test('baseUrls targeting: non-streaming JSON respects hit/miss', async () => {
    const { started } = startMockUpstream({
        json: {
            type: 'message',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 1000, output_tokens: 555 }
        }
    });
    const upstream = await started;
    const port = upstream.address().port;

    try {
        const missProxy = await startProxy(upstream, {
            usageScale: { enabled: true, ratio: 0.5, baseUrls: [`http://127.0.0.1:${port}/other`] }
        });
        try {
            const res = await post(missProxy.address().port);
            const body = JSON.parse(await res.text());
            assert.equal(body.usage.input_tokens, 1000);
        } finally {
            missProxy.closeAllConnections?.();
            missProxy.close();
        }
    } finally {
        upstream.closeAllConnections?.();
        upstream.close();
    }
});

test('usage scale enabled: error JSON passthrough untouched', async () => {
    const { started } = startMockUpstream({
        json: { type: 'error', error: { type: 'invalid_request_error', message: 'x' } }
    });
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        usageScale: { enabled: true, ratio: 0.5 }
    });

    try {
        const res = await post(proxy.address().port);
        const body = JSON.parse(await res.text());
        assert.equal(body.type, 'error');
        assert.equal(body.error.type, 'invalid_request_error');
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('baseUrls entry form: per-entry ratio overrides global', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const port = upstream.address().port;

    try {
        // 命中条目自带 ratio=0.25 → 按其缩放（而非全局 0.5）。
        const proxy = await startProxy(upstream, {
            usageScale: {
                enabled: true, ratio: 0.5,
                baseUrls: [{ url: `http://127.0.0.1:${port}`, ratio: 0.25 }]
            }
        });
        try {
            const res = await post(proxy.address().port);
            const events = await readSseEvents(res);
            const start = events.find((e) => e.type === 'message_start');
            assert.equal(start.message.usage.input_tokens, 250); // ceil(1000×0.25)
        } finally {
            proxy.closeAllConnections?.();
            proxy.close();
        }
    } finally {
        upstream.closeAllConnections?.();
        upstream.close();
    }
});

test('baseUrls entry form: string entry inherits global ratio', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const port = upstream.address().port;

    try {
        // 字符串条目 = 未指定比例 → 继承全局 ratio=0.5。
        const proxy = await startProxy(upstream, {
            usageScale: {
                enabled: true, ratio: 0.5,
                baseUrls: [`http://127.0.0.1:${port}`]
            }
        });
        try {
            const res = await post(proxy.address().port);
            const events = await readSseEvents(res);
            const start = events.find((e) => e.type === 'message_start');
            assert.equal(start.message.usage.input_tokens, 500); // ceil(1000×0.5)
        } finally {
            proxy.closeAllConnections?.();
            proxy.close();
        }
    } finally {
        upstream.closeAllConnections?.();
        upstream.close();
    }
});

test('baseUrls entry form: empty list scales every upstream by global', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const port = upstream.address().port;

    try {
        // 空列表 → 全量缩放（effort「未配置列表 = 全量」语义对齐）。
        const proxy = await startProxy(upstream, {
            usageScale: { enabled: true, ratio: 0.5, baseUrls: [] }
        });
        try {
            const res = await post(proxy.address().port);
            const events = await readSseEvents(res);
            const start = events.find((e) => e.type === 'message_start');
            assert.equal(start.message.usage.input_tokens, 500);
        } finally {
            proxy.closeAllConnections?.();
            proxy.close();
        }
    } finally {
        upstream.closeAllConnections?.();
        upstream.close();
    }
});

test('baseUrls entry form: duplicate normalized URL keeps first entry ratio', async () => {
    const { started } = startMockUpstream({ events: SSE_EVENTS });
    const upstream = await started;
    const port = upstream.address().port;

    try {
        // 尾斜杠归一后与首项同一 URL → 丢弃后项 0.25，保留首项（继承全局 0.5）。
        const proxy = await startProxy(upstream, {
            usageScale: {
                enabled: true, ratio: 0.5,
                baseUrls: [
                    `http://127.0.0.1:${port}`,
                    { url: `http://127.0.0.1:${port}/`, ratio: 0.25 }
                ]
            }
        });
        try {
            const res = await post(proxy.address().port);
            const events = await readSseEvents(res);
            const start = events.find((e) => e.type === 'message_start');
            assert.equal(start.message.usage.input_tokens, 500);
        } finally {
            proxy.closeAllConnections?.();
            proxy.close();
        }
    } finally {
        upstream.closeAllConnections?.();
        upstream.close();
    }
});
