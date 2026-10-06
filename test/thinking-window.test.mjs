import test from 'node:test';
import assert from 'node:assert/strict';
import {
    transformThinkingAsTextEvents,
    stripThinkingTextHistory,
    MAX_THINKING_TEXT_BLOCK_BYTES
} from '../src/thinking-text.js';

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
const HEADER = `${ANSI_DIM}💭 Thinking${ANSI_RESET}`;
const CURSOR_RE = /\x1b\[\d+A\r?\x1b\[J/;

function ev(type, extra = {}) { return { type, ...extra }; }

async function collect(events, options = { thinkingAsText: true }) {
    const out = [];
    for await (const e of transformThinkingAsTextEvents(events, options)) out.push(e);
    return out;
}

function bigThinkingEvent(index, bytes) {
    return ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: 'x'.repeat(bytes) } });
}

test('window off (default): no cursor control codes emitted', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n' } }),
        ev('content_block_stop', { index: 0 })
    ];
    const out = await collect(events);
    const texts = out.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
    assert.ok(!CURSOR_RE.test(texts), 'no cursor codes when window off');
});

test('window N=3: first 3 lines stream normally, 4th line triggers full rewrite', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'l1\nl2\nl3\nl4\n' } }),
        ev('content_block_stop', { index: 0 })
    ];
    const out = [];
    for await (const e of transformThinkingAsTextEvents(events, { thinkingAsText: true, windowLines: 3 })) out.push(e);
    const texts = out.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text);

    // 前 3 行正常流式（含 header 共 4 条 delta：header + 3 行）
    assert.equal(texts[0], HEADER);
    assert.equal(texts[1], `\n${ANSI_DIM}l1${ANSI_RESET}`);
    assert.equal(texts[2], `\n${ANSI_DIM}l2${ANSI_RESET}`);
    assert.equal(texts[3], `\n${ANSI_DIM}l3${ANSI_RESET}`);

    // 第 4 行：单 delta 整窗重写 — ESC[2A \r ESC[J + 首行无 \n 前导 + 其余 \n 分隔
    assert.match(texts[4], /^\x1b\[2A\r\x1b\[J/);
    assert.equal(texts[4], `\x1b[2A\r\x1b[J${ANSI_DIM}l2${ANSI_RESET}\n${ANSI_DIM}l3${ANSI_RESET}\n${ANSI_DIM}l4${ANSI_RESET}`);

    // stop：pending 已空，无 tail，只有耗时行（\n 前导追加在窗口下方）
    assert.equal(texts[5], `\n${ANSI_DIM}💭 Thought for 1s${ANSI_RESET}`);
});

test('window N=3: header not counted in window, window keeps latest 3 content lines', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'a\nb\nc\nd\ne\n' } }),
        ev('content_block_stop', { index: 0 })
    ];
    const out = [];
    for await (const e of transformThinkingAsTextEvents(events, { thinkingAsText: true, windowLines: 3 })) out.push(e);
    const lastRewrite = out.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).at(-2);
    assert.ok(lastRewrite.includes(`${ANSI_DIM}c${ANSI_RESET}`));
    assert.ok(lastRewrite.includes(`${ANSI_DIM}d${ANSI_RESET}`));
    assert.ok(lastRewrite.includes(`${ANSI_DIM}e${ANSI_RESET}`));
    assert.ok(!lastRewrite.includes('a') && !lastRewrite.includes('b'), 'oldest lines dropped');
});

test('window N=3: pending tail at stop joins window via rewrite', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'l1\nl2\nl3\nl4' } }), // l4 无换行 → stop 时为 tail
        ev('content_block_stop', { index: 0 })
    ];
    const out = [];
    for await (const e of transformThinkingAsTextEvents(events, { thinkingAsText: true, windowLines: 3 })) out.push(e);
    const texts = out.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text);
    // stop 时 tail(l4) 走整窗重写：l2,l3,l4
    assert.match(texts.at(-2), /^\x1b\[2A\r\x1b\[J/);
    assert.ok(texts.at(-2).includes(`${ANSI_DIM}l4${ANSI_RESET}`));
    assert.ok(!texts.at(-2).includes('l1'), 'l1 rolled out of window');
    // 耗时行仍在窗口下方
    assert.equal(texts.at(-1), `\n${ANSI_DIM}💭 Thought for 1s${ANSI_RESET}`);
});

test('window: multiple thinking blocks reset window independently', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'a\nb\nc\nd\n' } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'thinking_delta', thinking: 'x\ny\n' } }),
        ev('content_block_stop', { index: 1 })
    ];
    const out = [];
    for await (const e of transformThinkingAsTextEvents(events, { thinkingAsText: true, windowLines: 3 })) out.push(e);
    const idx1 = out.filter((e) => e.index === 1 && e.delta?.type === 'text_delta').map((e) => e.delta.text);
    // 第二个块只有 2 行 < 3：正常流式，无控制码
    assert.ok(!idx1.some((t) => CURSOR_RE.test(t)), 'second block never rewrites');
    assert.equal(idx1[0], HEADER);
});

test('window: discarded block emits no cursor codes', async () => {
    const events = [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'start\n' } }),
        bigThinkingEvent(0, MAX_THINKING_TEXT_BLOCK_BYTES),
        ev('content_block_stop', { index: 0 })
    ];
    const out = [];
    for await (const e of transformThinkingAsTextEvents(events, { thinkingAsText: true, windowLines: 3 })) out.push(e);
    const texts = out.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
    assert.ok(!CURSOR_RE.test(texts), 'discarded path emits no rewrite codes');
});

// ---------- 历史剥离：滚动窗口块 ----------

function windowRenderedText(lines, finalWindowLines, durationSecs) {
    // 按真实发射布局构造：header + 前 N 行流式 + 每次整窗重写 + 耗时行
    let text = HEADER;
    const N = finalWindowLines.length;
    for (const l of lines) text += `\n${ANSI_DIM}${l}${ANSI_RESET}`;
    text += `\x1b[${N - 1}A\r\x1b[J`;
    text += finalWindowLines.map((l) => `${ANSI_DIM}${l}${ANSI_RESET}`).join('\n');
    if (durationSecs != null) text += `\n${ANSI_DIM}💭 Thought for ${durationSecs}s${ANSI_RESET}`;
    return text;
}

test('strip: window-rendered block with cursor codes fully stripped', () => {
    const text = windowRenderedText(['l1', 'l2', 'l3', 'l4'], ['l2', 'l3', 'l4'], 8);
    const messages = [{ role: 'assistant', content: [{ type: 'text', text }] }];
    const out = stripThinkingTextHistory(messages);
    assert.equal(out[0].content.length, 0, 'whole block dropped');
});

test('strip: multiple rewrites + duration line fully stripped', () => {
    let text = HEADER;
    for (let i = 1; i <= 10; i++) text += `\n${ANSI_DIM}l${i}${ANSI_RESET}`;
    for (let k = 0; k < 4; k++) {
        text += `\x1b[9A\r\x1b[J${ANSI_DIM}w${k}0${ANSI_RESET}`;
        for (let i = 1; i < 10; i++) text += `\n${ANSI_DIM}w${k}${i}${ANSI_RESET}`;
    }
    text += `\n${ANSI_DIM}💭 Thought for 42s${ANSI_RESET}`;
    const messages = [{ role: 'assistant', content: [{ type: 'text', text }] }];
    const out = stripThinkingTextHistory(messages);
    assert.equal(out[0].content.length, 0, 'whole block dropped');
});

test('strip: mixed text around window block preserved', () => {
    const windowBlock = windowRenderedText(['l1', 'l2', 'l3', 'l4'], ['l2', 'l3', 'l4'], 8);
    const messages = [{
        role: 'assistant',
        content: [{ type: 'text', text: `before\n${windowBlock}\nafter` }]
    }];
    const out = stripThinkingTextHistory(messages);
    assert.equal(out[0].content[0].text, 'before\n\nafter');
});

test('strip: string content with window block stripped', () => {
    const windowBlock = windowRenderedText(['l1', 'l2', 'l3', 'l4'], ['l2', 'l3', 'l4'], 8);
    const messages = [{ role: 'assistant', content: `a\n${windowBlock}\nb` }];
    const out = stripThinkingTextHistory(messages);
    assert.ok(!out[0].content.includes('\x1b[9A') && !out[0].content.includes('💭'));
    assert.ok(out[0].content.startsWith('a\n'));
    assert.ok(out[0].content.endsWith('\nb'));
});
