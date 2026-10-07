import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
    formatDurationLine,
    formatThinkingAsText,
    stripThinkingTextHistory,
    isClaudeCodeUserAgent,
    transformThinkingAsTextEvents,
    MAX_THINKING_TEXT_BLOCK_BYTES,
    MAX_THINKING_TEXT_RESPONSE_BYTES
} from '../src/thinking-text.js';
import { createProxyServer } from '../src/proxy.js';
import { resolveUpstream } from '../src/upstream.js';

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
const HEADER = `${ANSI_DIM}💭 Thinking${ANSI_RESET}`;

function ev(type, extra = {}) { return { type, ...extra }; }

async function collect(events) {
    const out = [];
    for await (const e of transformThinkingAsTextEvents(events, { thinkingAsText: true })) out.push(e);
    return out;
}

async function* fromArray(arr) { yield* arr; }

// ---------- 时长格式 ----------

test('formatDurationLine: <60s shows Xs, >=60s shows XmYs, 1s floor', () => {
    const strip = (s) => s.replace(`${ANSI_DIM}💭 Thought for `, '').replace(ANSI_RESET, '');
    assert.equal(strip(formatDurationLine(0.2)), '1s');
    assert.equal(strip(formatDurationLine(59.4)), '59s');
    assert.equal(strip(formatDurationLine(60)), '1m0s');
    assert.equal(strip(formatDurationLine(76)), '1m16s');
    assert.equal(strip(formatDurationLine(600)), '10m0s');
    assert.equal(strip(formatDurationLine(3661)), '61m1s');
});

// ---------- 渲染格式 ----------

test('formatThinkingAsText: header + dim per-line, no trailing newline', () => {
    const out = formatThinkingAsText('line one\nline two');
    assert.equal(out, `${HEADER}\n${ANSI_DIM}line one${ANSI_RESET}\n${ANSI_DIM}line two${ANSI_RESET}`);
});

test('formatThinkingAsText: blank lines skipped, lines trimmed, CRLF normalized', () => {
    const out = formatThinkingAsText('  a  \r\n\r\n\nb\r\n');
    assert.equal(out, `${HEADER}\n${ANSI_DIM}a${ANSI_RESET}\n${ANSI_DIM}b${ANSI_RESET}`);
});

test('formatThinkingAsText: whitespace-only yields bare header, empty/null yield null', () => {
    // Empty string is falsy input → null; whitespace-only → bare header.
    assert.equal(formatThinkingAsText(''), null);
    assert.equal(formatThinkingAsText(null), null);
    assert.equal(formatThinkingAsText(undefined), null);
    assert.equal(formatThinkingAsText('\n \n'), HEADER);
});

test('formatThinkingAsText: null yields null', () => {
    assert.equal(formatThinkingAsText(null), null);
    assert.equal(formatThinkingAsText(undefined), null);
});

// ---------- 字节上限 ----------

function bigThinkingEvent(index, bytes) {
    return ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: 'x'.repeat(bytes) } });
}

test('block limit: oversized block dropped entirely (no orphan stop)', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        bigThinkingEvent(0, MAX_THINKING_TEXT_BLOCK_BYTES + 1),
        ev('content_block_stop', { index: 0 }),
        ev('message_stop')
    ];
    const out = await collect(events);
    // Only message_stop passes through; no text start/stop for index 0.
    assert.deepEqual(out.map((e) => e.type), ['message_stop']);
});

test('block limit: partially streamed block closes with its stop event', async () => {
    const half = Math.floor(MAX_THINKING_TEXT_BLOCK_BYTES / 3);
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'start\n' } }),
        bigThinkingEvent(0, half),
        bigThinkingEvent(0, half),
        bigThinkingEvent(0, MAX_THINKING_TEXT_BLOCK_BYTES), // pushes over limit
        ev('content_block_stop', { index: 0 }),
        ev('message_stop')
    ];
    const out = await collect(events);
    const types = out.map((e) => e.type);
    // Text emitted for the first lines; the oversized delta is dropped but
    // the stop event still arrives after the partial stream.
    assert.ok(types.includes('content_block_start'));
    assert.equal(types.filter((t) => t === 'content_block_stop').length, 1);
    const textDeltas = out.filter((e) => e.delta?.type === 'text_delta');
    assert.ok(textDeltas.length > 0, 'some text streamed before discard');
    assert.ok(!textDeltas.at(-1).delta.text.endsWith('\n'), 'block never ends with newline');
});

test('response limit: subsequent blocks discarded after 1MiB cumulative', async () => {
    const half = Math.floor(MAX_THINKING_TEXT_RESPONSE_BYTES / 2);
    const mk = (index) => [
        ev('content_block_start', { index, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: `block ${index} start\n` } }),
        bigThinkingEvent(index, half),
        bigThinkingEvent(index, half),
        ev('content_block_stop', { index })
    ];
    const events = [...mk(0), ...mk(1), ev('message_stop')];
    const out = await collect(events);
    const stopIndices = out.filter((e) => e.type === 'content_block_stop').map((e) => e.index);
    // Block 0 streams (partially), block 1 is fully discarded.
    assert.deepEqual(stopIndices, [0]);
});

// ---------- 流式：SSE 行缓冲、lazy start、signature 剥离 ----------

test('streaming: lazy content_block_start with header, no signature events', async () => {
    const events = [
        ev('message_start', { message: {} }),
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hello\nworld' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig==+' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_stop')
    ];
    const out = await collect(events);
    const types = out.map((e) => e.type);
    assert.deepEqual(types, [
        'message_start',
        'content_block_start',   // lazy: emitted with first line
        'content_block_delta',   // header
        'content_block_delta',   // \n dim hello
        'content_block_delta',   // \n dim world
        'content_block_stop',
        'message_stop'
    ]);
    const start = out[1];
    assert.deepEqual(start.content_block, { type: 'text', text: '' });
    const texts = out.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text);
    assert.equal(texts.join(''), `${HEADER}\n${ANSI_DIM}hello${ANSI_RESET}\n${ANSI_DIM}world${ANSI_RESET}\n${ANSI_DIM}💭 Thought for 1s${ANSI_RESET}`);
});

test('streaming: whitespace-only thinking block emits nothing (no orphan events)', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: ' \n ' } }),
        ev('content_block_stop', { index: 0 })
    ];
    const out = await collect(events);
    assert.deepEqual(out, []);
});

test('streaming: non-thinking events pass through unchanged', async () => {
    const events = [
        ev('message_start', { message: { id: 'm1' } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' } }),
        ev('message_stop')
    ];
    const out = await collect(fromArray(events));
    assert.deepEqual(out, events);
});

test('streaming: thinkingAsText off passes everything through', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } }),
        ev('content_block_stop', { index: 0 })
    ];
    const out = [];
    for await (const e of transformThinkingAsTextEvents(fromArray(events), { thinkingAsText: false })) out.push(e);
    assert.deepEqual(out, events);
});

test('streaming: mid-block unrelated event closes pending block state', async () => {
    // A text block interleaved between thinking start and delta: thinking
    // pending state must reset so later deltas of a different index don't leak.
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'other' } }),
        ev('message_stop')
    ];
    const out = await collect(events);
    assert.deepEqual(out.map((e) => e.type), ['content_block_delta', 'message_stop']);
});

// ---------- UA 门控 ----------

test('UA gate: claude-cli / claude-code match, others do not', () => {
    assert.ok(isClaudeCodeUserAgent('claude-cli'));
    assert.ok(isClaudeCodeUserAgent('claude-cli/2.1.231'));
    assert.ok(isClaudeCodeUserAgent('claude-code 1.0.0'));
    assert.ok(isClaudeCodeUserAgent('Claude-Code/2.0'));
    assert.ok(!isClaudeCodeUserAgent('curl/8.0'));
    assert.ok(!isClaudeCodeUserAgent('my-claude-cli/1.0'));
    assert.ok(!isClaudeCodeUserAgent(undefined));
    assert.ok(!isClaudeCodeUserAgent(null));
});

// ---------- 历史剥离 ----------

test('stripThinkingTextHistory: removes rendered thinking blocks from text blocks', () => {
    const rendered = `${HEADER}\n${ANSI_DIM}thought line${ANSI_RESET}`;
    const messages = [
        { role: 'user', content: [{ type: 'text', text: rendered }] }, // user untouched
        {
            role: 'assistant',
            content: [
                { type: 'text', text: `before\n${rendered}\nafter` },
                { type: 'text', text: rendered }, // becomes empty → dropped
                { type: 'tool_use', id: 't1', name: 'f', input: {} }
            ]
        }
    ];
    const out = stripThinkingTextHistory(messages);
    assert.equal(out[0].content[0].text, rendered, 'user messages untouched');
    assert.equal(out[1].content.length, 2);
    assert.equal(out[1].content[0].text, 'before\n\nafter');
    assert.equal(out[1].content[1].type, 'tool_use');
});

test('stripThinkingTextHistory: string content stripped, legacy marker variant stripped', () => {
    const LEGACY_PREFIX = `${ANSI_DIM}> 💭 Thinking⁣agy-thinking-text-v1⁣`;
    const legacyBlock = `${LEGACY_PREFIX}\n> old\n${ANSI_RESET}`;
    const messages = [{
        role: 'assistant',
        content: `a\n${HEADER}\n> x${ANSI_RESET}\nb\n${legacyBlock}\nc`
    }];
    const out = stripThinkingTextHistory(messages);
    assert.ok(!out[0].content.includes('💭'));
    assert.ok(!out[0].content.includes('agy-thinking-text-v1'));
    assert.ok(out[0].content.startsWith('a\n'));
    assert.ok(out[0].content.endsWith('c'));
});

test('stripThinkingTextHistory: previous quoted (`> ` prefix) format stripped', () => {
    const QUOTED_HEADER = `> ${ANSI_DIM}💭 Thinking${ANSI_RESET}`;
    const messages = [{
        role: 'assistant',
        content: `a\n${QUOTED_HEADER}\n> ${ANSI_DIM}quoted thought${ANSI_RESET}\nb`
    }];
    const out = stripThinkingTextHistory(messages);
    assert.ok(!out[0].content.includes('💭'));
    assert.ok(!out[0].content.includes('quoted thought'));
    assert.ok(out[0].content.startsWith('a\n'));
    assert.ok(out[0].content.endsWith('\nb'));
});

test('stripThinkingTextHistory: non-array / non-assistant passthrough', () => {
    assert.equal(stripThinkingTextHistory('nope'), 'nope');
    const msgs = [{ role: 'user', content: 'hi' }];
    assert.deepEqual(stripThinkingTextHistory(msgs), msgs);
});

// ---------- 上游 URL 解析 ----------

test('resolveUpstream: default upstream official API', () => {
    const t = resolveUpstream('/v1/messages?beta=true', undefined);
    assert.equal(t.host, 'api.anthropic.com');
    assert.equal(t.protocol, 'https:');
    assert.equal(t.path, '/v1/messages?beta=true');
});

test('resolveUpstream: custom base with path prefix', () => {
    const t = resolveUpstream('/v1/messages', 'http://localhost:3000/api');
    assert.equal(t.host, 'localhost');
    assert.equal(t.port, '3000');
    assert.equal(t.path, '/api/v1/messages');
});

test('resolveUpstream: base with root path adds no prefix', () => {
    const t = resolveUpstream('/v1/messages', 'http://localhost:3000/');
    assert.equal(t.path, '/v1/messages');
});

// ---------- 集成：代理端到端（mock 上游 SSE，含跨 chunk 缓冲） ----------

function startMockUpstream(events) {
    const server = http.createServer((req, res) => {
        const bodyEvents = [];
        req.on('data', (c) => bodyEvents.push(c));
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            // Split raw SSE bytes at arbitrary boundaries to exercise buffering.
            const raw = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
            const bytes = Buffer.from(raw, 'utf8');
            let i = 0;
            const step = Math.max(1, Math.floor(bytes.length / 7));
            const timer = setInterval(() => {
                if (i >= bytes.length) { clearInterval(timer); res.end(); return; }
                res.write(bytes.subarray(i, i + step));
                i += step;
            }, 5);
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- 集成：代理端到端（mock 上游 SSE，含跨 chunk 缓冲） ----------

// 真实网关形态：thinking 块中途夹发 ping，且 thinking 块无 thinking_delta
// 只有 signature_delta（gpt 系模型经网关转 Anthropic 协议的典型序列）。
test('proxy e2e: ping inside thinking block keeps tracking, no orphan events leak', async () => {
    const upstreamEvents = [
        ev('message_start', { message: {} }),
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('ping'),
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-only' } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"北京"}' } }),
        ev('content_block_stop', { index: 1 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 5 } }),
        ev('message_stop')
    ];
    const upstream = await startMockUpstream(upstreamEvents);
    const proxy = createProxyServer({ baseUrlEnv: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.1.231', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: '查天气' }] })
        });
        assert.equal(res.status, 200);
        const raw = await res.text();
        assert.ok(!raw.includes('signature_delta'), 'signature events stripped');
        assert.ok(raw.includes('"type":"tool_use"'), 'tool_use block passed through');
        assert.ok(raw.includes('"stop_reason":"tool_use"'), 'message_delta passed through');

        // 输出事件序列完整性：任何 content_block_delta/stop 的 index 必须先有
        // 对应 content_block_start（孤儿事件会让 CC 解析中断、表现为无回复）。
        const outEvents = raw.split('\n\n').filter(Boolean).map((b) => {
            const d = b.match(/^data: (.+)$/m);
            return d ? JSON.parse(d[1]) : null;
        }).filter(Boolean);
        const startedIndexes = new Set();
        for (const e of outEvents) {
            if (e.type === 'content_block_start') startedIndexes.add(e.index);
            if ((e.type === 'content_block_delta' || e.type === 'content_block_stop') && e.index !== undefined) {
                assert.ok(startedIndexes.has(e.index), `index=${e.index} ${e.type} must follow its content_block_start`);
            }
        }
        assert.ok(outEvents.some((e) => e.type === 'ping'), 'ping passthrough');
        assert.equal(outEvents.at(-1).type, 'message_stop', 'stream ends with message_stop');
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('proxy e2e: rewrites thinking to text for CC UA, splits across chunks', async () => {
    const upstreamEvents = [
        ev('message_start', { message: {} }),
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'deep thought\nsecond line' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'xyz' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_stop')
    ];
    const upstream = await startMockUpstream(upstreamEvents);
    const upstreamPort = upstream.address().port;

    const proxy = createProxyServer({ baseUrlEnv: `http://127.0.0.1:${upstreamPort}` });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = proxy.address().port;

    try {
        const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.1.231', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
        });
        assert.equal(res.status, 200);
        const raw = await res.text();
        assert.ok(!raw.includes('signature_delta'), 'signature events stripped');
        assert.ok(raw.includes('💭 Thinking'), 'rendered header present');
        assert.ok(raw.includes(`\\n\\u001b[2mdeep thought\\u001b[0m`), 'dim line rendering present');
        assert.ok(raw.includes('second line'));

        // Non-CC client gets verbatim passthrough.
        const res2 = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'curl/8.0', 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [] })
        });
        const raw2 = await res2.text();
        assert.ok(raw2.includes('signature_delta'), 'non-CC gets original events');
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('proxy e2e: request-side history strip applied for CC UA', async () => {
    let capturedBody = null;
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

    const proxy = createProxyServer({ baseUrlEnv: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const rendered = `${HEADER}\n${ANSI_DIM}old${ANSI_RESET}`;
        await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-code/2.0', 'content-type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'assistant', content: [{ type: 'text', text: `keep\n${rendered}` }] }]
            })
        });
        assert.ok(capturedBody);
        assert.equal(capturedBody.messages[0].content[0].text, 'keep\n');
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('proxy e2e: non-streaming message JSON thinking blocks rewritten for CC UA', async () => {
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'hidden thought\nline two', signature: 'sig==' },
                    { type: 'text', text: 'answer' }
                ]
            }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const proxy = createProxyServer({ baseUrlEnv: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.1.231', 'content-type': 'application/json' },
            body: '{}'
        });
        const body = await res.json();
        assert.equal(body.content[0].type, 'text');
        assert.ok(body.content[0].text.startsWith(HEADER));
        assert.ok(body.content[0].text.includes('hidden thought'));
        assert.equal(body.content[0].signature, undefined, 'signature stripped');
        assert.deepEqual(body.content[1], { type: 'text', text: 'answer' });

        // Non-CC client gets the original thinking block verbatim.
        const res2 = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'curl/8.0', 'content-type': 'application/json' },
            body: '{}'
        });
        const body2 = await res2.json();
        assert.equal(body2.content[0].type, 'thinking');
        assert.equal(body2.content[0].signature, 'sig==');
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('proxy e2e: unparsable SSE event is skipped without killing the stream', async () => {
    const upstream = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('event: message_start\ndata: {"type":"message_start","message":{}}\n\n');
            res.write('data: {not json at all\n\n');           // unparsable
            res.write('data: 12345\n\n');                       // parses, but not an object
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const proxy = createProxyServer({ baseUrlEnv: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.1.231', 'content-type': 'application/json' },
            body: '{}'
        });
        const raw = await res.text();
        assert.ok(raw.includes('message_start'), 'first event survived');
        assert.ok(raw.includes('message_stop'), 'stream continued past the bad events');
        assert.ok(!raw.includes('not json at all'), 'unparsable payload not forwarded');
        assert.ok(!raw.includes('event: undefined'), 'no malformed event line emitted');
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('proxy e2e: upstream failure yields 502 JSON error', async () => {
    const proxy = createProxyServer({ baseUrlEnv: 'http://127.0.0.1:1' }); // port 1 = closed
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.0' },
            body: '{}'
        });
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(body.type, 'error');
        assert.equal(body.error.type, 'api_error');
    } finally {
        proxy.close();
    }
});
