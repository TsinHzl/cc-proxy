import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    extractUsage,
    extractUsageFromResponseEvents,
    createUsageTracker
} from '../src/usage.js';

function tmpFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-usage-')), 'usage.json');
}

// 与实现一致的本地日界 key（dayKey 未导出，测试端复刻）。
function localDayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

test('extractUsage: snake_case fields kept, invalid/negative coerced to 0, missing returns null', () => {
    assert.deepEqual(extractUsage({ input_tokens: 10, output_tokens: 5 }), {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
    });
    // 全 0 也是真实用量（如空回复），不应判为无效。
    assert.deepEqual(extractUsage({ input_tokens: 0, output_tokens: 0 }), {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
    });
    // usage 对象存在即有效（缺失字段按 0），只有非对象才返回 null。
    assert.equal(extractUsage(null), null);
    assert.deepEqual(extractUsage({}), {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
    });
});

test('extractUsageFromResponseEvents: message_start then message_delta merges output', () => {
    const usage = extractUsageFromResponseEvents([
        { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
        { type: 'message_delta', usage: { output_tokens: 42 } }
    ]);
    assert.deepEqual(usage, {
        inputTokens: 100,
        outputTokens: 42,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
    });
});

test('extractUsageFromResponseEvents: non-usage events ignored', () => {
    assert.equal(extractUsageFromResponseEvents([{ type: 'ping' }, { type: 'message_stop' }]), null);
});

test('tracker: records accumulate per day and persist to file', () => {
    const file = tmpFile();
    const tracker = createUsageTracker({ usageFile: file });
    tracker.record({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
    tracker.record({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 });
    assert.deepEqual(tracker.summary(), {
        day: localDayKey(),
        requests: 2,
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        persisted: true
    });
    // 重开 tracker 读同一文件，累计保留。
    const again = createUsageTracker({ usageFile: file });
    again.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
    assert.equal(again.summary().requests, 3);
    assert.equal(again.summary().inputTokens, 12);
});

test('tracker: corrupted file falls back to empty and recovers', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'not json');
    const tracker = createUsageTracker({ usageFile: file });
    tracker.record({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
    assert.equal(tracker.summary().requests, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[tracker.summary().day].requests, 1);
});

test('tracker: record(null) is a no-op', () => {
    const file = tmpFile();
    const tracker = createUsageTracker({ usageFile: file });
    tracker.record(null);
    assert.equal(tracker.summary().requests, 0);
    assert.equal(fs.existsSync(file), false);
});
