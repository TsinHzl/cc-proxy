import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCost, cacheHitRate, computeUsageAlert } from '../src/pricing.js';

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

// ---------- computeUsageAlert ----------

test('computeUsageAlert: threshold boundaries 79%/80%/99%/100%', () => {
    const args = { dailyTokens: 1000, todayTokens: 0, dailyCost: 0, todayCost: null };
    assert.deepEqual(computeUsageAlert({ ...args, todayTokens: 790 }), { level: 'none', exceeded: false, ratio: 0.79 });
    assert.deepEqual(computeUsageAlert({ ...args, todayTokens: 800 }), { level: 'warn', exceeded: false, ratio: 0.8 });
    assert.deepEqual(computeUsageAlert({ ...args, todayTokens: 990 }), { level: 'warn', exceeded: false, ratio: 0.99 });
    assert.deepEqual(computeUsageAlert({ ...args, todayTokens: 1000 }), { level: 'limit', exceeded: true, ratio: 1 });
    assert.deepEqual(computeUsageAlert({ ...args, todayTokens: 1200 }), { level: 'limit', exceeded: true, ratio: 1.2 });
});

test('computeUsageAlert: cost ratio participates, max of configured budgets wins', () => {
    // tokens 50%，费用 90% → 取最大值 0.9 → warn。
    const out = computeUsageAlert({
        dailyTokens: 1000, todayTokens: 500,
        dailyCost: 10, todayCost: 9, thresholds: { warnThreshold: 0.8, limitThreshold: 1 }
    });
    assert.deepEqual(out, { level: 'warn', exceeded: false, ratio: 0.9 });
});

test('computeUsageAlert: unconfigured budgets yield level none, ratio 0', () => {
    assert.deepEqual(
        computeUsageAlert({ dailyTokens: 0, dailyCost: 0, todayTokens: 9999, todayCost: 99 }),
        { level: 'none', exceeded: false, ratio: 0 }
    );
    // 费用已配置但 todayCost 为 null（费用不可估）时费用项不计入。
    assert.deepEqual(
        computeUsageAlert({ dailyTokens: 0, dailyCost: 10, todayTokens: 0, todayCost: null }),
        { level: 'none', exceeded: false, ratio: 0 }
    );
});

test('computeUsageAlert: default thresholds 0.8/1.0 when omitted', () => {
    const out = computeUsageAlert({ dailyTokens: 100, todayTokens: 85, dailyCost: 0, todayCost: null });
    assert.equal(out.level, 'warn');
});

test('computeUsageAlert: non-finite today values are ignored instead of NaN', () => {
    // undefined 严格不等于 null，旧实现会进入费用分支产出 NaN。
    assert.deepEqual(
        computeUsageAlert({ dailyTokens: 100, dailyCost: 10, todayTokens: undefined, todayCost: undefined }),
        { level: 'none', exceeded: false, ratio: 0 }
    );
    assert.deepEqual(
        computeUsageAlert({ dailyTokens: 100, dailyCost: 10, todayTokens: 50, todayCost: NaN }),
        // 默认阈值 0.8：50/100=0.5 未达 warn，仅验证 NaN 不产出比值。
        { level: 'none', exceeded: false, ratio: 0.5 }
    );
});
