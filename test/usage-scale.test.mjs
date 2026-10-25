import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    scaleUsageForClient,
    scaleUsageInEvent,
    scaleUsageInMessageJson
} from '../src/usage-scale.js';

// ---------- scaleUsageForClient ----------

test('scaleUsageForClient: scales input-class fields, output untouched', () => {
    const usage = {
        input_tokens: 1000,
        output_tokens: 555,
        cache_creation_input_tokens: 40,
        cache_read_input_tokens: 200
    };
    const scaled = scaleUsageForClient(usage, 0.5);
    assert.equal(scaled.input_tokens, 500);
    assert.equal(scaled.cache_creation_input_tokens, 20);
    assert.equal(scaled.cache_read_input_tokens, 100);
    assert.equal(scaled.output_tokens, 555);
    // 不可变更新：原对象不被修改。
    assert.equal(usage.input_tokens, 1000);
    assert.equal(usage.cache_read_input_tokens, 200);
});

test('scaleUsageForClient: ratio=1 returns the original reference', () => {
    const usage = { input_tokens: 10, output_tokens: 2 };
    assert.equal(scaleUsageForClient(usage, 1), usage);
});

test('scaleUsageForClient: ceil rounding so non-zero stays non-zero', () => {
    const scaled = scaleUsageForClient({ input_tokens: 3, output_tokens: 1 }, 0.5);
    assert.equal(scaled.input_tokens, 2); // ceil(1.5)
    const tiny = scaleUsageForClient({ input_tokens: 1 }, 0.1);
    assert.equal(tiny.input_tokens, 1); // ceil(0.1) = 1，非零不为 0
    // 放大路径：ratio > 1。
    const up = scaleUsageForClient({ input_tokens: 3, output_tokens: 7 }, 2);
    assert.equal(up.input_tokens, 6);
    assert.equal(up.output_tokens, 7);
});

test('scaleUsageForClient: missing / non-positive fields stay as-is', () => {
    const usage = { input_tokens: 100, output_tokens: 0 };
    const scaled = scaleUsageForClient(usage, 0.5);
    // 未出现的 cache 字段不补写；output=0 保持 0。
    assert.equal(scaled.cache_creation_input_tokens, undefined);
    assert.equal(scaled.output_tokens, 0);
    // 非正整数字段（字符串/负数）原样保留。
    const weird = { input_tokens: 'many', cache_read_input_tokens: -5 };
    const scaledWeird = scaleUsageForClient(weird, 0.5);
    assert.equal(scaledWeird.input_tokens, 'many');
    assert.equal(scaledWeird.cache_read_input_tokens, -5);
});

test('scaleUsageForClient: nested cache_creation ephemeral fields scaled', () => {
    const usage = {
        input_tokens: 100,
        cache_creation_input_tokens: 40,
        cache_creation: {
            ephemeral_5m_input_tokens: 30,
            ephemeral_1h_input_tokens: 10,
            unrelated: 'keep'
        }
    };
    const scaled = scaleUsageForClient(usage, 0.5);
    assert.equal(scaled.cache_creation.ephemeral_5m_input_tokens, 15);
    assert.equal(scaled.cache_creation.ephemeral_1h_input_tokens, 5);
    assert.equal(scaled.cache_creation.unrelated, 'keep');
    assert.equal(usage.cache_creation.ephemeral_5m_input_tokens, 30);
});

test('scaleUsageForClient: invalid usage input returns null', () => {
    assert.equal(scaleUsageForClient(null, 0.5), null);
    assert.equal(scaleUsageForClient('x', 0.5), null);
    assert.equal(scaleUsageForClient([1], 0.5), null);
});

// ---------- scaleUsageInEvent ----------

test('scaleUsageInEvent: message_start usage scaled via new event object', () => {
    const event = {
        type: 'message_start',
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 1 } }
    };
    const scaled = scaleUsageInEvent(event, 0.5);
    assert.notEqual(scaled, event);
    assert.equal(scaled.message.usage.input_tokens, 50);
    assert.equal(scaled.message.usage.output_tokens, 1);
    assert.equal(scaled.message.model, 'claude-sonnet-5');
    assert.equal(event.message.usage.input_tokens, 100);
});

test('scaleUsageInEvent: message_delta usage scaled', () => {
    const event = {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 42 }
    };
    // output_tokens 不缩放：改写后与原值相同 → 返回原事件引用。
    assert.equal(scaleUsageInEvent(event, 0.5), event);
    const withInput = {
        type: 'message_delta',
        delta: {},
        usage: { input_tokens: 10, output_tokens: 42 }
    };
    const scaled = scaleUsageInEvent(withInput, 3);
    assert.equal(scaled.usage.input_tokens, 30);
    assert.equal(scaled.usage.output_tokens, 42);
});

test('scaleUsageInEvent: unrelated event types pass through untouched', () => {
    const event = { type: 'content_block_delta', delta: { text: 'hi' } };
    assert.equal(scaleUsageInEvent(event, 0.5), event);
    const ping = { type: 'ping' };
    assert.equal(scaleUsageInEvent(ping, 0.5), ping);
    assert.equal(scaleUsageInEvent(null, 0.5), null);
});

test('scaleUsageInEvent: malformed truthy non-object usage passes through', () => {
    // 畸形 usage（字符串/数字）：不缩放也不改写为 null，原事件透传。
    const start = { type: 'message_start', message: { usage: 'malformed' } };
    assert.equal(scaleUsageInEvent(start, 0.5), start);
    const delta = { type: 'message_delta', usage: 42 };
    assert.equal(scaleUsageInEvent(delta, 0.5), delta);
});

// ---------- scaleUsageInMessageJson ----------

test('scaleUsageInMessageJson: message usage scaled, error untouched', () => {
    const message = {
        type: 'message',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 200, cache_read_input_tokens: 60, output_tokens: 5 }
    };
    const scaled = scaleUsageInMessageJson(message, 0.5);
    assert.equal(scaled.usage.input_tokens, 100);
    assert.equal(scaled.usage.cache_read_input_tokens, 30);
    assert.equal(scaled.usage.output_tokens, 5);
    assert.equal(message.usage.input_tokens, 200);
    const error = { type: 'error', error: { message: 'prompt is too long' } };
    assert.equal(scaleUsageInMessageJson(error, 0.5), error);
});

test('scaleUsageInMessageJson: non-message / no-usage passthrough', () => {
    const noUsage = { type: 'message', content: [] };
    assert.equal(scaleUsageInMessageJson(noUsage, 0.5), noUsage);
    assert.equal(scaleUsageInMessageJson(null, 0.5), null);
});

test('scaleUsageInMessageJson: malformed truthy non-object usage passes through', () => {
    const message = { type: 'message', usage: 'malformed' };
    assert.equal(scaleUsageInMessageJson(message, 0.5), message);
});

// 定向匹配原语（normalizeBaseUrl / buildBaseUrlTargetSet /
// isBaseUrlTargetHit）的测试已迁至 test/base-url-match.test.mjs。
