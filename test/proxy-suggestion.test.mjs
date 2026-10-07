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

