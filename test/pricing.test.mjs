import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCost, cacheHitRate } from '../src/pricing.js';

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-pricing-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const DAY = {
    requests: 1,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
};

test('estimateCost: built-in pricing with prefix match on dated variants', () => {
    // 日期后缀变体前缀命中 claude-sonnet-5：3*1 + 15*0.1 = 4.5 USD。
    const cost = estimateCost(DAY, 'claude-sonnet-5-20261001');
    assert.equal(cost, 4.5);
});

test('estimateCost: config pricing overrides built-in (exact key wins)', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'),
        JSON.stringify({ models: { 'claude-sonnet-5': { pricing: { input: 10, output: 20 } } } }));
    // 覆盖价缺 cacheRead/cacheCreation 维度 → 整体返回 null。
    assert.equal(estimateCost(DAY, 'claude-sonnet-5', dir), null);
    // 补全四维后按覆盖价计算。
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        models: { 'claude-sonnet-5': { pricing: { input: 10, output: 20, cacheRead: 1, cacheCreation: 2 } } }
    }));
    assert.equal(estimateCost(DAY, 'claude-sonnet-5', dir), 10 + 2);
});

test('estimateCost: config prefix match (longest prefix wins)', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        models: {
            'claude': { pricing: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } },
            'claude-sonnet': { pricing: { input: 2, output: 2, cacheRead: 0, cacheCreation: 0 } }
        }
    }));
    // 最长前缀 claude-sonnet 命中。
    assert.equal(estimateCost(DAY, 'claude-sonnet-5-20261001', dir), 2 + 0.2);
});

test('estimateCost: unknown model returns null', () => {
    assert.equal(estimateCost(DAY, 'gpt-9-turbo'), null);
    assert.equal(estimateCost(null, 'claude-sonnet-5'), null);
});

test('estimateCost: flat config pricing format accepted', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'),
        JSON.stringify({ models: { 'claude-sonnet-5': { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } } }));
    assert.equal(estimateCost(DAY, 'claude-sonnet-5', dir), 1 + 0.1);
});

test('cacheHitRate: ratio, zero denominator null, invalid input null', () => {
    assert.equal(cacheHitRate({ inputTokens: 30, cacheReadTokens: 60, cacheCreationTokens: 10 }), 0.6);
    assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), null);
    assert.equal(cacheHitRate(null), null);
    assert.equal(cacheHitRate({}), null);
});
