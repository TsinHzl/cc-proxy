import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyServer } from '../src/proxy.js';
import { createSystemPromptCapture } from '../src/system-prompt.js';

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

function tmpFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-proxy-sysprompt-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'captured-system-prompt.json');
}

function bodyWithSystem(extra = {}) {
    return JSON.stringify({
        messages: [{ role: 'user', content: '主对话输入' }],
        system: [
            { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }
        ],
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

function teardown(proxy, upstream) {
    proxy.closeAllConnections?.();
    upstream.closeAllConnections?.();
    proxy.close();
    upstream.close();
}

test('system prompt override enabled: replaces blocks system with single text block', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        systemPromptOverride: { enabled: true, prompt: '自定义提示词' }
    });

    try {
        const res = await post(proxy.address().port, bodyWithSystem());
        await res.text();
        assert.equal(res.status, 200);
        const forwarded = JSON.parse(state.bodies[0]);
        assert.deepEqual(forwarded.system, [{ type: 'text', text: '自定义提示词', cache_control: { type: 'ephemeral' } }]);
        assert.ok(forwarded.messages[0].content.includes('主对话输入'));
    } finally {
        teardown(proxy, upstream);
    }
});

test('system prompt override enabled: replaces string system', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        systemPromptOverride: { enabled: true, prompt: '自定义提示词' }
    });
    const raw = JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        system: 'original prompt'
    });

    try {
        const res = await post(proxy.address().port, raw);
        await res.text();
        const forwarded = JSON.parse(state.bodies[0]);
        assert.equal(forwarded.system, '自定义提示词');
    } finally {
        teardown(proxy, upstream);
    }
});

test('system prompt override disabled: body forwarded byte-identical', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        systemPromptOverride: { enabled: false, prompt: '自定义提示词' }
    });
    const raw = bodyWithSystem();

    try {
        const res = await post(proxy.address().port, raw);
        await res.text();
        assert.equal(state.bodies[0], raw);
    } finally {
        teardown(proxy, upstream);
    }
});

test('system prompt override with empty prompt: no-op byte passthrough', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        systemPromptOverride: { enabled: true, prompt: '' }
    });
    const raw = bodyWithSystem();

    try {
        const res = await post(proxy.address().port, raw);
        await res.text();
        assert.equal(state.bodies[0], raw);
    } finally {
        teardown(proxy, upstream);
    }
});

test('system prompt override: missing system field is not added', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        systemPromptOverride: { enabled: true, prompt: '自定义提示词' }
    });
    const raw = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

    try {
        const res = await post(proxy.address().port, raw);
        await res.text();
        assert.equal(state.bodies[0], raw);
        assert.equal('system' in JSON.parse(state.bodies[0]), false);
    } finally {
        teardown(proxy, upstream);
    }
});

test('capture: non-suggestion CC request writes extracted system to file', async (t) => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const file = tmpFile(t);
    const proxy = await startProxy(upstream, {
        systemPromptCapture: createSystemPromptCapture({ file }),
        systemPromptOverride: { enabled: true, prompt: '自定义提示词' }
    });

    try {
        const res = await post(proxy.address().port, bodyWithSystem());
        await res.text();
        // 覆写开启期间捕获的仍是覆写前的原始 system 文本。
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
            prompt: 'You are Claude Code.'
        });
        // 请求本身仍按覆写后的链路转发。
        const forwarded = JSON.parse(state.bodies[0]);
        assert.equal(forwarded.system[0].text, '自定义提示词');
    } finally {
        teardown(proxy, upstream);
    }
});

test('capture: suggestion mode request is not captured', async (t) => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const file = tmpFile(t);
    const proxy = await startProxy(upstream, {
        systemPromptCapture: createSystemPromptCapture({ file }),
        forwardSuggestionMode: true
    });
    const raw = JSON.stringify({
        messages: [{ role: 'user', content: '[SUGGESTION MODE] suggest' }],
        system: 'suggestion system'
    });

    try {
        const res = await post(proxy.address().port, raw);
        await res.text();
        assert.equal(fs.existsSync(file), false);
    } finally {
        teardown(proxy, upstream);
    }
});

test('capture: non-CC UA and invalid JSON are not captured, forwarded verbatim', async (t) => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const file = tmpFile(t);
    const proxy = await startProxy(upstream, {
        systemPromptCapture: createSystemPromptCapture({ file })
    });
    const raw = '{"messages": broken';

    try {
        // 非 CC UA。
        const curl = await post(proxy.address().port, bodyWithSystem(), {
            'user-agent': 'curl/8.0', connection: 'close'
        });
        await curl.text();
        // 非法 JSON（CC UA）。
        const broken = await post(proxy.address().port, raw);
        await broken.text();
        assert.equal(fs.existsSync(file), false);
        assert.equal(state.bodies[0], bodyWithSystem());
        assert.equal(state.bodies[1], raw);
    } finally {
        teardown(proxy, upstream);
    }
});

test('non-CC user agent: system override skipped, verbatim body', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        systemPromptOverride: { enabled: true, prompt: '自定义提示词' }
    });
    const raw = bodyWithSystem();

    try {
        const res = await post(proxy.address().port, raw, {
            'user-agent': 'curl/8.0', connection: 'close'
        });
        await res.text();
        assert.equal(state.bodies[0], raw);
    } finally {
        teardown(proxy, upstream);
    }
});

test('invalid JSON body: system override skipped, forwarded verbatim', async () => {
    const { state, started } = startMockUpstream();
    const upstream = await started;
    const proxy = await startProxy(upstream, {
        systemPromptOverride: { enabled: true, prompt: '自定义提示词' }
    });
    const raw = '{"messages": broken';

    try {
        const res = await post(proxy.address().port, raw);
        await res.text();
        assert.equal(state.bodies[0], raw);
    } finally {
        teardown(proxy, upstream);
    }
});
