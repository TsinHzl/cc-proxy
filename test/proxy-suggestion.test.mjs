import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/proxy.js';
import { createUsageTracker } from '../src/usage.js';
import { SUGGESTION_MARKER } from '../src/suggestion-mode.js';

// Mock upstream：记录收到的请求体，返回最小 SSE 响应。
function startMockUpstream() {
    const state = { bodies: [] };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            state.bodies.push(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: { usage: { input_tokens: 10, output_tokens: 1 } }
            })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 }
            })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            res.end();
        });
    });
    const started = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
    return { state, started };
}

// connection: close：禁用 undici keep-alive，防止连接池 socket 跨测试残留导致进程挂起。
const CC_HEADERS = { 'user-agent': 'claude-cli/2.1', 'content-type': 'application/json', connection: 'close' };
const suggestionBody = JSON.stringify({
    messages: [{ role: 'user', content: `${SUGGESTION_MARKER}: suggest next input` }],
    stream: false
});
const suggestionBodyStream = JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'text', text: `${SUGGESTION_MARKER}: suggest` }] }],
    stream: true
});
const normalBody = JSON.stringify({ messages: [{ role: 'user', content: '正常主对话输入' }] });

test('suggestion request intercepted by default: empty JSON, upstream untouched, zero usage', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const tracker = createUsageTracker({ usageFile: '/dev/null' });
    const proxy = createProxyServer({ baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`, usageTracker: tracker });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: CC_HEADERS, body: suggestionBody
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /application\/json/);
        const parsed = await res.json();
        assert.equal(parsed.type, 'message');
        assert.deepEqual(parsed.content, [{ type: 'text', text: '' }]);
        assert.equal(parsed.stop_reason, 'end_turn');
        // 拦截路径零 usage 统计：tracker 未收到任何记录。
        assert.equal(tracker.summary().requests, 0);
        // 上游未收到任何请求体。
        assert.equal(state.bodies.length, 0);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('streaming suggestion request intercepted: full SSE event sequence', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = createProxyServer({ baseUrlEnv: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: CC_HEADERS, body: suggestionBodyStream
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/event-stream/);
        const text = await res.text();
        const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
        assert.deepEqual(types, ['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop']);
        assert.equal(state.bodies.length, 0);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('forwardSuggestionMode=true: suggestion request forwarded upstream', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        forwardSuggestionMode: true
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: CC_HEADERS, body: suggestionBody
        });
        await res.text();
        assert.equal(state.bodies.length, 1);
        assert.ok(state.bodies[0].includes(SUGGESTION_MARKER));
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('non-suggestion CC request passes through normally in both switch states', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;

    try {
        for (const forwardSuggestionMode of [false, true]) {
            const proxy = createProxyServer({
                baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
                forwardSuggestionMode
            });
            await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
            try {
                const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
                    method: 'POST', headers: CC_HEADERS, body: normalBody
                });
                await res.text();
                assert.equal(res.status, 200);
            } finally {
                proxy.closeAllConnections?.();
                proxy.close();
            }
        }
        assert.equal(state.bodies.length, 2);
        assert.ok(state.bodies.every((b) => b.includes('正常主对话输入')));
    } finally {
        // upstream 必须纳入 finally 关闭，否则循环内断言失败会残留 listening 句柄导致进程挂起。
        upstream.closeAllConnections?.();
        upstream.close();
    }
});

// ---- 定向列表（forwardSuggestionMode: { enabled, baseUrls }）----

// 以主上游完整 base 为条目 URL：normalizeBaseUrl 归一后与实际 base 同串。
const primaryBaseOf = (upstream) => `http://127.0.0.1:${upstream.address().port}`;

test('suggestion policy: baseUrls forward=true overrides global intercept', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = createProxyServer({
        baseUrlEnv: primaryBaseOf(upstream),
        forwardSuggestionMode: {
            enabled: false,
            baseUrls: [{ url: primaryBaseOf(upstream), forward: true }]
        }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: CC_HEADERS, body: suggestionBody
        });
        await res.text();
        assert.equal(res.status, 200);
        // 命中条目强制转发：建议请求触达上游（非空响应来自 mock）。
        assert.equal(state.bodies.length, 1);
        assert.ok(state.bodies[0].includes(SUGGESTION_MARKER));
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('suggestion policy: baseUrls forward=false overrides global forward', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = createProxyServer({
        baseUrlEnv: primaryBaseOf(upstream),
        forwardSuggestionMode: {
            enabled: true,
            baseUrls: [{ url: primaryBaseOf(upstream), forward: false }]
        }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: CC_HEADERS, body: suggestionBody
        });
        const parsed = await res.json();
        // 命中条目强制拦截：返回结构完整的空消息，上游零触达。
        assert.equal(parsed.stop_reason, 'end_turn');
        assert.deepEqual(parsed.content, [{ type: 'text', text: '' }]);
        assert.equal(state.bodies.length, 0);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

test('suggestion policy: unmatched upstream inherits global switch', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    // 列表指向另一个上游：本条请求未命中任何条目 → 按全局 enabled=false 拦截。
    const proxy = createProxyServer({
        baseUrlEnv: primaryBaseOf(upstream),
        forwardSuggestionMode: {
            enabled: false,
            baseUrls: [{ url: 'https://other.example.com', forward: true }]
        }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: CC_HEADERS, body: suggestionBody
        });
        const parsed = await res.json();
        assert.equal(parsed.stop_reason, 'end_turn');
        assert.equal(state.bodies.length, 0);
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

// 拦截请求不占用 half-open 探测名额：主上游 open + 存在备用时，放行路径会经
// finalizeTargets 调 probe()；拦截路径必须在 probe 之前返回。
test('suggestion intercept never consumes half-open probe slot', async () => {
    const primary = await startMockUpstream().started;
    const { state: backupState, started: backupStarted } = startMockUpstream();
    const backup = await backupStarted;
    const primaryHost = '127.0.0.1';
    const makeBreaker = () => {
        const probed = [];
        return {
            probed,
            isOpen: (id) => id === primaryHost,
            getState: (id) => (id === primaryHost ? 'open' : 'closed'),
            probe: (id) => {
                probed.push(id);
                return { allowed: true, isProbe: true };
            },
            recordSuccess: () => {},
            recordFailure: () => {},
            getSnapshot: () => ({})
        };
    };

    const run = async (forwardSuggestionMode) => {
        const breaker = makeBreaker();
        const proxy = createProxyServer({
            baseUrlEnv: primaryBaseOf(primary),
            forwardSuggestionMode,
            failoverUpstreams: [{ name: 'backup', baseUrl: primaryBaseOf(backup) }],
            upstreamBreaker: breaker
        });
        await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
        try {
            const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
                method: 'POST', headers: CC_HEADERS, body: suggestionBody
            });
            await res.text();
        } finally {
            proxy.closeAllConnections?.();
            proxy.close();
        }
        return breaker.probed;
    };

    try {
        // 全局拦截：不触达任何上游、不调 probe。
        const intercepted = await run({ enabled: false, baseUrls: [] });
        assert.deepEqual(intercepted, []);
        assert.equal(backupState.bodies.length, 0);

        // 全局转发：主上游 open → 选路切到备用并占用其探测名额。
        const forwarded = await run({ enabled: true, baseUrls: [] });
        assert.deepEqual(forwarded, ['backup']);
        assert.equal(backupState.bodies.length, 1);
    } finally {
        primary.closeAllConnections?.();
        backup.closeAllConnections?.();
        primary.close();
        backup.close();
    }
});

test('non-CC client sending suggestion payload: forwarded verbatim (unaffected)', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = createProxyServer({ baseUrlEnv: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: { 'user-agent': 'curl/8.0', connection: 'close' }, body: suggestionBody
        });
        await res.text();
        assert.equal(state.bodies.length, 1);
        assert.ok(state.bodies[0].includes(SUGGESTION_MARKER));
    } finally {
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
    }
});

// probe 被并发占用 → finalizeTargets 回退到备用上游；策略须按真实服务上游复核，
// 否则备用的 forward:false 会被绕过（本次 CR High 修复的回归测试）。
test('probe rejected: fallback upstream forward=false still intercepts', async () => {
    const primary = await startMockUpstream().started;
    const { state: backupState, started: backupStarted } = startMockUpstream();
    const backup = await backupStarted;
    const primaryHost = '127.0.0.1';
    // 模拟：主上游 half-open（isOpen=false 故排为首选），但 probe 名额被并发占用。
    const probed = [];
    const breaker = {
        isOpen: () => false,
        getState: (id) => (id === primaryHost ? 'half-open' : 'closed'),
        probe: (id) => {
            probed.push(id);
            return { allowed: false, isProbe: false };
        },
        recordSuccess: () => {},
        recordFailure: () => {},
        getSnapshot: () => ({})
    };
    const proxy = createProxyServer({
        baseUrlEnv: primaryBaseOf(primary),
        forwardSuggestionMode: {
            enabled: true,
            baseUrls: [{ url: primaryBaseOf(backup), forward: false }]
        },
        failoverUpstreams: [{ name: 'backup', baseUrl: primaryBaseOf(backup) }],
        upstreamBreaker: breaker
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: CC_HEADERS, body: suggestionBody
        });
        const parsed = await res.json();
        // 真实服务上游为 backup（forward:false）→ 拦截，备用上游零触达。
        assert.equal(parsed.stop_reason, 'end_turn');
        assert.deepEqual(parsed.content, [{ type: 'text', text: '' }]);
        assert.equal(backupState.bodies.length, 0);
        // 主上游 probe 被尝试过一次（预判链路），无溢出重复调用。
        assert.deepEqual(probed, [primaryHost]);
    } finally {
        proxy.closeAllConnections?.();
        primary.closeAllConnections?.();
        backup.closeAllConnections?.();
        proxy.close();
        primary.close();
        backup.close();
    }
});

