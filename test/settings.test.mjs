import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, defaultConfigPath, readConfig, writeConfig } from '../src/settings.js';

const EXPECTED_DEFAULT_CONFIG = {
    thinkingWindow: { enabled: false, lines: 10 },
    forwardSuggestionMode: false,
    thinkingAsText: true,
    effortOverride: { enabled: true, level: 'high', baseUrls: [] },
    systemPromptOverride: { enabled: false, prompt: '' },
    usageScale: { enabled: false, ratio: 1.0, baseUrls: [] },
    alerts: { dailyTokens: 0, dailyCost: 0 },
    usageAlert: { warnThreshold: 0.8, limitThreshold: 1 },
    models: {},
    upstreams: []
};

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-settings-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('readConfig: missing file returns defaults, no file created', (t) => {
    const dir = tmpDir(t);
    assert.deepEqual(readConfig(dir), EXPECTED_DEFAULT_CONFIG);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('readConfig: malformed JSON falls back to defaults', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), '{not json');
    assert.deepEqual(readConfig(dir), EXPECTED_DEFAULT_CONFIG);
});

test('readConfig: invalid lines values fall back to 10', (t) => {
    const dir = tmpDir(t);
    for (const lines of [0, -5, 3.5, '20', 101]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingWindow: { lines } }));
        assert.equal(readConfig(dir).thinkingWindow.lines, 10, `lines=${JSON.stringify(lines)}`);
    }
});

test('readConfig: boundary lines 1 and 100 accepted', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingWindow: { lines: 1 } }));
    assert.equal(readConfig(dir).thinkingWindow.lines, 1);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingWindow: { lines: 100 } }));
    assert.equal(readConfig(dir).thinkingWindow.lines, 100);
});

test('readConfig: non-boolean enabled falls back to false', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingWindow: { enabled: 'yes' } }));
    assert.equal(readConfig(dir).thinkingWindow.enabled, false);
});

test('readConfig: non-object JSON (array/number) falls back to defaults', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), '[1,2]');
    assert.deepEqual(readConfig(dir), EXPECTED_DEFAULT_CONFIG);
});

test('readConfig: old config without thinkingAsText defaults it to true', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        thinkingWindow: { enabled: true, lines: 25 },
        forwardSuggestionMode: true
    }));
    assert.deepEqual(readConfig(dir), {
        thinkingWindow: { enabled: true, lines: 25 },
        forwardSuggestionMode: true,
        thinkingAsText: true,
        effortOverride: { enabled: true, level: 'high', baseUrls: [] },
        systemPromptOverride: { enabled: false, prompt: '' },
        usageScale: { enabled: false, ratio: 1, baseUrls: [] },
        alerts: { dailyTokens: 0, dailyCost: 0 },
        usageAlert: { warnThreshold: 0.8, limitThreshold: 1 },
        models: {},
        upstreams: []
    });
});

test('readConfig: explicit boolean false disables thinkingAsText', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingAsText: false }));
    assert.equal(readConfig(dir).thinkingAsText, false);
});

// ---------- effortOverride ----------

test('readConfig: old config without effortOverride defaults it to enabled/high', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        thinkingWindow: { enabled: true, lines: 25 },
        forwardSuggestionMode: true
    }));
    assert.deepEqual(readConfig(dir).effortOverride, { enabled: true, level: 'high', baseUrls: [] });
});

test('readConfig: explicit effortOverride values persist', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        effortOverride: { enabled: false, level: 'low' }
    }));
    assert.deepEqual(readConfig(dir).effortOverride, { enabled: false, level: 'low', baseUrls: [] });
});

test('readConfig: explicit effortOverride.baseUrls persist', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        effortOverride: {
            enabled: true, level: 'max',
            baseUrls: ['https://a.com/api', 'http://b.com:8080']
        }
    }));
    assert.deepEqual(readConfig(dir).effortOverride.baseUrls,
        ['https://a.com/api', 'http://b.com:8080']);
});

test('readConfig: invalid effortOverride.baseUrls items dropped individually', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        effortOverride: {
            baseUrls: ['https://ok.com', 42, '', 'not a url', 'ftp://x.com', null]
        }
    }));
    assert.deepEqual(readConfig(dir).effortOverride.baseUrls, ['https://ok.com']);
    // 非数组退化为空列表 = 全量覆写语义。
    for (const baseUrls of ['https://x.com', 7, { a: 1 }]) {
        fs.writeFileSync(path.join(dir, 'config.json'),
            JSON.stringify({ effortOverride: { baseUrls } }));
        assert.deepEqual(readConfig(dir).effortOverride.baseUrls, [],
            `baseUrls=${JSON.stringify(baseUrls)}`);
    }
});

test('readConfig: invalid effortOverride fields fall back field-by-field', (t) => {
    const dir = tmpDir(t);
    for (const enabled of [null, 0, 1, 'false', []]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            effortOverride: { enabled, level: 'medium' }
        }));
        assert.equal(readConfig(dir).effortOverride.enabled, true, `enabled=${JSON.stringify(enabled)}`);
    }
    for (const level of [null, 0, 'extreme', 'HIGH', [], {}]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            effortOverride: { enabled: false, level }
        }));
        assert.equal(readConfig(dir).effortOverride.level, 'high', `level=${JSON.stringify(level)}`);
    }
    // 新增档位 xhigh / max / ultracode 为合法值，不被回退。
    for (const level of ['xhigh', 'max', 'ultracode']) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            effortOverride: { enabled: false, level }
        }));
        assert.equal(readConfig(dir).effortOverride.level, level, `level=${level}`);
    }
});

test('readConfig: non-object effortOverride falls back to defaults', (t) => {
    const dir = tmpDir(t);
    for (const effortOverride of [null, 'high', 7, ['low']]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ effortOverride }));
        assert.deepEqual(readConfig(dir).effortOverride, { enabled: true, level: 'high', baseUrls: [] });
    }
});

test('writeConfig: effortOverride partial merge keeps sibling field', (t) => {
    const dir = tmpDir(t);
    writeConfig({ effortOverride: { enabled: false, level: 'low' } }, dir);
    const out = writeConfig({ effortOverride: { level: 'medium' } }, dir);
    // 逐字段合并：只改 level 时 enabled 保留原值 false。
    assert.equal(out.effortOverride.level, 'medium');
    assert.equal(out.effortOverride.enabled, false);
});

test('writeConfig: effortOverride.baseUrls replaces whole array, sibling fields kept', (t) => {
    const dir = tmpDir(t);
    writeConfig({
        effortOverride: { enabled: false, level: 'low', baseUrls: ['https://a.com'] }
    }, dir);
    const out = writeConfig({ effortOverride: { baseUrls: ['https://b.com'] } }, dir);
    // 数组整体替换；未提供的 enabled / level 保留。
    assert.deepEqual(out.effortOverride.baseUrls, ['https://b.com']);
    assert.equal(out.effortOverride.enabled, false);
    assert.equal(out.effortOverride.level, 'low');
});

test('writeConfig: effortOverride write keeps other top-level settings', (t) => {
    const dir = tmpDir(t);
    writeConfig({ forwardSuggestionMode: true, thinkingAsText: false }, dir);
    const out = writeConfig({ effortOverride: { level: 'low' } }, dir);
    // 防丢失：写 effortOverride 不得重置已保存的顶层开关。
    assert.equal(out.forwardSuggestionMode, true);
    assert.equal(out.thinkingAsText, false);
    assert.deepEqual(out.effortOverride, { enabled: true, level: 'low', baseUrls: [] });
});

test('readConfig: invalid thinkingAsText values fall back to true', (t) => {
    const dir = tmpDir(t);
    for (const thinkingAsText of [null, 0, 1, 'false', [], {}]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingAsText }));
        assert.equal(
            readConfig(dir).thinkingAsText,
            true,
            `thinkingAsText=${JSON.stringify(thinkingAsText)}`
        );
    }
});

// ---------- systemPromptOverride ----------

test('readConfig: old config without systemPromptOverride defaults it to disabled/empty', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        thinkingWindow: { enabled: true, lines: 25 },
        forwardSuggestionMode: true
    }));
    assert.deepEqual(readConfig(dir).systemPromptOverride, { enabled: false, prompt: '' });
});

test('readConfig: explicit systemPromptOverride values persist', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        systemPromptOverride: { enabled: true, prompt: '自定义提示词' }
    }));
    assert.deepEqual(readConfig(dir).systemPromptOverride, { enabled: true, prompt: '自定义提示词' });
});

test('readConfig: invalid systemPromptOverride fields fall back field-by-field', (t) => {
    const dir = tmpDir(t);
    for (const enabled of [null, 0, 1, 'true', []]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            systemPromptOverride: { enabled, prompt: 'x' }
        }));
        assert.equal(readConfig(dir).systemPromptOverride.enabled, false, `enabled=${JSON.stringify(enabled)}`);
    }
    for (const prompt of [null, 0, 42, true, [], {}]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            systemPromptOverride: { enabled: true, prompt }
        }));
        assert.equal(readConfig(dir).systemPromptOverride.prompt, '', `prompt=${JSON.stringify(prompt)}`);
    }
});

test('readConfig: prompt over 256KB falls back to empty string', (t) => {
    const dir = tmpDir(t);
    // 边界内：256KB 以内的多字节中文（UTF-8 计）接受。
    const atLimit = 'a'.repeat(256 * 1024 - 3) + '中';
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        systemPromptOverride: { enabled: true, prompt: atLimit }
    }));
    assert.equal(readConfig(dir).systemPromptOverride.prompt, atLimit);
    // 超限：整段回退空串而非截断。
    const overLimit = atLimit + '中';
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        systemPromptOverride: { enabled: true, prompt: overLimit }
    }));
    assert.equal(readConfig(dir).systemPromptOverride.prompt, '');
});

test('readConfig: non-object systemPromptOverride falls back to defaults', (t) => {
    const dir = tmpDir(t);
    for (const systemPromptOverride of [null, 'x', 7, ['enabled']]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ systemPromptOverride }));
        assert.deepEqual(readConfig(dir).systemPromptOverride, { enabled: false, prompt: '' });
    }
});

test('writeConfig: systemPromptOverride partial merge keeps sibling field', (t) => {
    const dir = tmpDir(t);
    writeConfig({ systemPromptOverride: { enabled: true, prompt: 'v1' } }, dir);
    const out = writeConfig({ systemPromptOverride: { prompt: 'v2' } }, dir);
    // 逐字段合并：只改 prompt 时 enabled 保留原值 true。
    assert.equal(out.systemPromptOverride.prompt, 'v2');
    assert.equal(out.systemPromptOverride.enabled, true);
});

test('writeConfig: systemPromptOverride write keeps other top-level settings', (t) => {
    const dir = tmpDir(t);
    writeConfig({ forwardSuggestionMode: true, thinkingAsText: false }, dir);
    const out = writeConfig({ systemPromptOverride: { prompt: 'x' } }, dir);
    // 防丢失：写 systemPromptOverride 不得重置已保存的顶层开关。
    assert.equal(out.forwardSuggestionMode, true);
    assert.equal(out.thinkingAsText, false);
    assert.deepEqual(out.systemPromptOverride, { enabled: false, prompt: 'x' });
});

// ---------- usageScale ----------

test('readConfig: old config without usageScale defaults it to disabled/ratio 1', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        thinkingWindow: { enabled: true, lines: 25 }
    }));
    assert.deepEqual(readConfig(dir).usageScale, { enabled: false, ratio: 1, baseUrls: [] });
});

test('readConfig: explicit usageScale values persist (incl. ratio > 1)', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        usageScale: { enabled: true, ratio: 0.6657 }
    }));
    assert.deepEqual(readConfig(dir).usageScale, { enabled: true, ratio: 0.6657, baseUrls: [] });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        usageScale: { enabled: true, ratio: 2.5 }
    }));
    assert.deepEqual(readConfig(dir).usageScale, { enabled: true, ratio: 2.5, baseUrls: [] });
    // 上界 10 为合法闭区间端点。
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        usageScale: { enabled: true, ratio: 10 }
    }));
    assert.deepEqual(readConfig(dir).usageScale, { enabled: true, ratio: 10, baseUrls: [] });
});

test('readConfig: invalid usageScale fields fall back field-by-field', (t) => {
    const dir = tmpDir(t);
    for (const enabled of [null, 0, 1, 'true', []]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            usageScale: { enabled, ratio: 0.5 }
        }));
        assert.equal(readConfig(dir).usageScale.enabled, false, `enabled=${JSON.stringify(enabled)}`);
        // enabled 非法不影响 ratio 保留。
        assert.equal(readConfig(dir).usageScale.ratio, 0.5);
    }
    for (const ratio of [0, -1, 10.1, NaN, Infinity, '0.5', null, true]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            usageScale: { enabled: true, ratio }
        }));
        assert.equal(readConfig(dir).usageScale.ratio, 1, `ratio=${JSON.stringify(ratio)}`);
    }
});

test('readConfig: non-object usageScale falls back to defaults', (t) => {
    const dir = tmpDir(t);
    for (const usageScale of [null, 'x', 7, ['enabled']]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ usageScale }));
        assert.deepEqual(readConfig(dir).usageScale, { enabled: false, ratio: 1, baseUrls: [] });
    }
});

test('writeConfig: usageScale partial merge keeps sibling field', (t) => {
    const dir = tmpDir(t);
    writeConfig({ usageScale: { enabled: true, ratio: 0.5 } }, dir);
    const out = writeConfig({ usageScale: { ratio: 2 } }, dir);
    // 逐字段合并：只改 ratio 时 enabled 保留原值 true。
    assert.equal(out.usageScale.ratio, 2);
    assert.equal(out.usageScale.enabled, true);
});

test('writeConfig: usageScale write keeps other top-level settings', (t) => {
    const dir = tmpDir(t);
    writeConfig({ forwardSuggestionMode: true, thinkingAsText: false }, dir);
    const out = writeConfig({ usageScale: { enabled: true } }, dir);
    assert.equal(out.forwardSuggestionMode, true);
    assert.equal(out.thinkingAsText, false);
    assert.deepEqual(out.usageScale, { enabled: true, ratio: 1, baseUrls: [] });
});

test('readConfig: usageScale.baseUrls invalid items dropped per-item', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        usageScale: {
            enabled: true,
            ratio: 0.5,
            baseUrls: ['https://gw.example.com/api', '::bad::', 42, '', 'ftp://x.com', 'https://ok.com']
        }
    }));
    // 非法项（不可解析 / 非字符串 / 空 / 非 http(s)）逐项丢弃，合法项原样保留。
    assert.deepEqual(readConfig(dir).usageScale.baseUrls,
        ['https://gw.example.com/api', 'https://ok.com']);
});

test('readConfig: usageScale.baseUrls items trimmed on normalize', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        usageScale: {
            enabled: true,
            ratio: 0.5,
            baseUrls: ['  https://a.com/api  ', '\thttp://b.com\t']
        }
    }));
    // 手改配置的首尾空白在归一阶段去除，与设置 API / 设置页口径一致。
    assert.deepEqual(readConfig(dir).usageScale.baseUrls,
        ['https://a.com/api', 'http://b.com']);
});

test('readConfig: usageScale.baseUrls all-invalid degrades to empty list', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        usageScale: { enabled: true, ratio: 0.5, baseUrls: ['::a::', '::b::'] }
    }));
    // 全部非法 → 空数组（等效「全量缩放」，README 已注明该边界）。
    assert.deepEqual(readConfig(dir).usageScale.baseUrls, []);
});

test('readConfig: usageScale.baseUrls non-array ignored, keeps default', (t) => {
    const dir = tmpDir(t);
    for (const baseUrls of ['https://x.com', { 0: 'https://x.com' }, null]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            usageScale: { enabled: true, ratio: 0.5, baseUrls }
        }));
        assert.deepEqual(readConfig(dir).usageScale.baseUrls, [],
            `baseUrls=${JSON.stringify(baseUrls)}`);
    }
});

test('writeConfig: usageScale.baseUrls array replaced wholesale, sibling kept', (t) => {
    const dir = tmpDir(t);
    writeConfig({ usageScale: { enabled: true, ratio: 0.5, baseUrls: ['https://a.com'] } }, dir);
    const out = writeConfig({ usageScale: { baseUrls: ['https://b.com/api', 'https://c.com'] } }, dir);
    // 数组整体替换；enabled/ratio 未在 partial 中提交则保留。
    assert.deepEqual(out.usageScale.baseUrls, ['https://b.com/api', 'https://c.com']);
    assert.equal(out.usageScale.enabled, true);
    assert.equal(out.usageScale.ratio, 0.5);
});

// ---------- alerts / models.pricing ----------

test('readConfig: invalid alerts.dailyTokens falls back to 0', (t) => {
    const dir = tmpDir(t);
    for (const dailyTokens of [null, '100', -1, 3.5, Infinity, NaN, []]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ alerts: { dailyTokens } }));
        assert.equal(readConfig(dir).alerts.dailyTokens, 0, `dailyTokens=${JSON.stringify(dailyTokens)}`);
    }
    // alerts 整体非对象回退默认。
    for (const alerts of [null, 'x', 7, [1]]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ alerts }));
        assert.deepEqual(readConfig(dir).alerts, { dailyTokens: 0, dailyCost: 0 });
    }
});

test('readConfig: valid alerts.dailyTokens persists (boundary 0)', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ alerts: { dailyTokens: 0 } }));
    assert.equal(readConfig(dir).alerts.dailyTokens, 0);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ alerts: { dailyTokens: 500000 } }));
    assert.equal(readConfig(dir).alerts.dailyTokens, 500000);
});

test('readConfig: models.pricing keeps only valid numeric fields, drops entries without any', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        models: {
            'claude-sonnet-5': { pricing: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75, junk: 'x' } },
            'bad-entry': { pricing: { input: 'free', output: -1 } },   // 无合法字段 → 剔除
            'no-pricing': {},                                          // 缺 pricing → 剔除
            'pricing-array': { pricing: [1, 2] }                       // pricing 为数组 → 剔除
        }
    }));
    const models = readConfig(dir).models;
    assert.deepEqual(models['claude-sonnet-5'], { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 });
    assert.equal(Object.keys(models).length, 1);
});

test('readConfig: invalid models container falls back to empty object', (t) => {
    const dir = tmpDir(t);
    for (const models of [null, 'x', 7, ['claude']]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ models }));
        assert.deepEqual(readConfig(dir).models, {});
    }
});

test('readConfig: flat models pricing format (entry itself) is accepted', (t) => {
    const dir = tmpDir(t);
    // 平铺格式：条目本身就是定价对象（无 pricing 包装层）。
    fs.writeFileSync(path.join(dir, 'config.json'), '{"models":{"m1":{"input":1}}}');
    // null 原型容器：deepEqual 对原型敏感，逐键断言内容。
    const models = readConfig(dir).models;
    assert.deepEqual({ ...models }, { m1: { input: 1 } });
});

test('readConfig: dangerous model keys (__proto__/constructor) persist as own properties', (t) => {
    const dir = tmpDir(t);
    // 手写原始 JSON：JS 字面量 __proto__: 会设置原型而非自有键，JSON.stringify 后消失。
    fs.writeFileSync(path.join(dir, 'config.json'),
        '{"models":{"__proto__":{"pricing":{"input":1}},"constructor":{"pricing":{"output":2}}}}');
    const models = readConfig(dir).models;
    // null 原型容器下危险键为自有属性：可读回，不污染原型。
    assert.deepEqual(models['__proto__'], { input: 1 });
    assert.deepEqual(models['constructor'], { output: 2 });
});

test('writeConfig: alerts and models merge without losing sibling settings', (t) => {
    const dir = tmpDir(t);
    writeConfig({ alerts: { dailyTokens: 1000 }, models: { 'm1': { pricing: { input: 1 } } } }, dir);
    // 二次写其他字段时 alerts / models 不被静默丢弃。
    const out = writeConfig({ thinkingAsText: false }, dir);
    assert.deepEqual(out.alerts, { dailyTokens: 1000, dailyCost: 0 });
    assert.deepEqual(out.models['m1'], { input: 1 });
    assert.equal(out.thinkingAsText, false);
});

test('writeConfig: alerts partial merge keeps dailyTokens, models partial merge keeps other models', (t) => {
    const dir = tmpDir(t);
    writeConfig({ models: { 'm1': { pricing: { input: 1 } }, 'm2': { pricing: { output: 2 } } } }, dir);
    const out = writeConfig({ models: { 'm3': { pricing: { cacheRead: 0.5 } } } }, dir);
    assert.deepEqual(out.models['m1'], { input: 1 });
    assert.deepEqual(out.models['m2'], { output: 2 });
    assert.deepEqual(out.models['m3'], { cacheRead: 0.5 });
});

// ---------- 写入与合并 ----------

test('writeConfig: creates dir and file, merged result returned', (t) => {
    const dir = tmpDir(t);
    const out = writeConfig({ thinkingWindow: { enabled: true, lines: 25 } }, dir);
    assert.equal(out.thinkingWindow.enabled, true);
    assert.equal(out.thinkingWindow.lines, 25);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), out);
});

test('writeConfig: creates new config with mode 0600', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');

    writeConfig({ thinkingAsText: false }, dir);

    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeConfig: preserves existing config mode', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(EXPECTED_DEFAULT_CONFIG));
    fs.chmodSync(file, 0o640);

    writeConfig({ thinkingAsText: false }, dir);

    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.equal(readConfig(dir).thinkingAsText, false);
});

test('writeConfig: partial merge keeps other field', (t) => {
    const dir = tmpDir(t);
    writeConfig({ thinkingWindow: { enabled: true, lines: 5 } }, dir);
    const out = writeConfig({ thinkingWindow: { lines: 7 } }, dir);
    // 逐字段合并：只改 lines 时 enabled 保留原值 true。
    assert.equal(out.thinkingWindow.lines, 7);
    assert.equal(out.thinkingWindow.enabled, true);
});

test('writeConfig: forwardSuggestionMode persists, defaults to false', (t) => {
    const dir = tmpDir(t);
    assert.equal(readConfig(dir).forwardSuggestionMode, false);
    const out = writeConfig({ forwardSuggestionMode: true }, dir);
    assert.equal(out.forwardSuggestionMode, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).forwardSuggestionMode, true);
});

test('writeConfig: thinkingWindow write keeps forwardSuggestionMode (top-level merge)', (t) => {
    const dir = tmpDir(t);
    writeConfig({ forwardSuggestionMode: true }, dir);
    const out = writeConfig({ thinkingWindow: { enabled: true, lines: 3 } }, dir);
    // 防丢失：写 thinkingWindow 不得重置已保存的顶层开关。
    assert.equal(out.forwardSuggestionMode, true);
    assert.equal(out.thinkingWindow.lines, 3);
});

test('normalizeConfig: non-boolean forwardSuggestionMode falls back to false', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ forwardSuggestionMode: 'yes' }));
    assert.equal(readConfig(dir).forwardSuggestionMode, false);
});

test('writeConfig: cross-field partial writes preserve unrelated settings', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
        thinkingWindow: { enabled: true, lines: 30 },
        forwardSuggestionMode: true,
        thinkingAsText: false,
        effortOverride: { enabled: false, level: 'low', baseUrls: ['https://a.com'] }
    }));

    let out = writeConfig({ thinkingWindow: { lines: 40 } }, dir);
    assert.deepEqual(out, {
        thinkingWindow: { enabled: true, lines: 40 },
        forwardSuggestionMode: true,
        thinkingAsText: false,
        effortOverride: { enabled: false, level: 'low', baseUrls: ['https://a.com'] },
        systemPromptOverride: { enabled: false, prompt: '' },
        usageScale: { enabled: false, ratio: 1, baseUrls: [] },
        alerts: { dailyTokens: 0, dailyCost: 0 },
        usageAlert: { warnThreshold: 0.8, limitThreshold: 1 },
        models: {},
        upstreams: []
    });

    out = writeConfig({ forwardSuggestionMode: false }, dir);
    assert.deepEqual(out, {
        thinkingWindow: { enabled: true, lines: 40 },
        forwardSuggestionMode: false,
        thinkingAsText: false,
        effortOverride: { enabled: false, level: 'low', baseUrls: ['https://a.com'] },
        systemPromptOverride: { enabled: false, prompt: '' },
        usageScale: { enabled: false, ratio: 1, baseUrls: [] },
        alerts: { dailyTokens: 0, dailyCost: 0 },
        usageAlert: { warnThreshold: 0.8, limitThreshold: 1 },
        models: {},
        upstreams: []
    });

    out = writeConfig({ thinkingAsText: true }, dir);
    assert.deepEqual(out, {
        thinkingWindow: { enabled: true, lines: 40 },
        forwardSuggestionMode: false,
        thinkingAsText: true,
        effortOverride: { enabled: false, level: 'low', baseUrls: ['https://a.com'] },
        systemPromptOverride: { enabled: false, prompt: '' },
        usageScale: { enabled: false, ratio: 1, baseUrls: [] },
        alerts: { dailyTokens: 0, dailyCost: 0 },
        usageAlert: { warnThreshold: 0.8, limitThreshold: 1 },
        models: {},
        upstreams: []
    });

    out = writeConfig({ effortOverride: { enabled: true, level: 'medium' } }, dir);
    assert.deepEqual(out, {
        thinkingWindow: { enabled: true, lines: 40 },
        forwardSuggestionMode: false,
        thinkingAsText: true,
        // 未提交 baseUrls：逐字段合并保留原列表（不被重置为空）。
        effortOverride: { enabled: true, level: 'medium', baseUrls: ['https://a.com'] },
        systemPromptOverride: { enabled: false, prompt: '' },
        usageScale: { enabled: false, ratio: 1, baseUrls: [] },
        alerts: { dailyTokens: 0, dailyCost: 0 },
        usageAlert: { warnThreshold: 0.8, limitThreshold: 1 },
        models: {},
        upstreams: []
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), out);
});

test('writeConfig: temp write failure preserves original config and removes temp file', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');
    const original = '{"thinkingAsText":false}\n';
    fs.writeFileSync(file, original);

    const realWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (target, data, ...args) => {
        const targetPath = String(target);
        if (path.dirname(targetPath) === dir && targetPath !== file) {
            realWriteFileSync(targetPath, '{"partial"', ...args);
            throw new Error('simulated temp write failure');
        }
        return realWriteFileSync(target, data, ...args);
    };
    t.after(() => { fs.writeFileSync = realWriteFileSync; });

    assert.throws(() => writeConfig({ thinkingAsText: true }, dir), /simulated temp write failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('writeConfig: rename failure preserves original config and removes temp file', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');
    const original = '{"thinkingAsText":false}\n';
    fs.writeFileSync(file, original);

    const realRenameSync = fs.renameSync;
    let observedTemp;
    fs.renameSync = (source, destination) => {
        observedTemp = String(source);
        assert.equal(path.dirname(observedTemp), dir);
        assert.equal(String(destination), file);
        throw new Error('simulated rename failure');
    };
    t.after(() => { fs.renameSync = realRenameSync; });

    assert.throws(() => writeConfig({ thinkingAsText: true }, dir), /simulated rename failure/);
    assert.ok(observedTemp);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('defaultConfigPath: points at ~/.cc-proxy/config.json', () => {
    assert.equal(defaultConfigPath(), path.join(os.homedir(), '.cc-proxy', 'config.json'));
});

test('DEFAULT_CONFIG contains expected defaults and is frozen', () => {
    assert.deepEqual(DEFAULT_CONFIG, EXPECTED_DEFAULT_CONFIG);
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
});

// ---------- upstreams（多上游故障转移配置） ----------

test('readConfig: valid upstream entries are kept with name defaulting to host', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        upstreams: [
            { name: 'gw2', baseUrl: 'https://gw2.example.com', headers: { 'x-api-key': 'sk-2' } },
            { baseUrl: 'https://gw3.example.com/api' }
        ]
    }));
    assert.deepEqual(readConfig(dir).upstreams, [
        { name: 'gw2', baseUrl: 'https://gw2.example.com', headers: { 'x-api-key': 'sk-2' } },
        { name: 'gw3.example.com', baseUrl: 'https://gw3.example.com/api' }
    ]);
});

test('readConfig: upstream entries with unparsable baseUrl are dropped entirely', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        upstreams: [{ baseUrl: 'not a url' }, { name: 'ok', baseUrl: 'https://ok.example.com' }]
    }));
    // 非法 baseUrl 会让 resolveUpstream 抛错崩溃，配置侧整项丢弃。
    assert.deepEqual(readConfig(dir).upstreams, [
        { name: 'ok', baseUrl: 'https://ok.example.com' }
    ]);
});

test('readConfig: invalid upstream entries are dropped, non-array falls back to []', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        upstreams: [
            null,
            'x',
            42,
            [],
            { baseUrl: '' },
            { baseUrl: 123 },
            { name: 'ok', baseUrl: 'https://ok.example.com' }
        ]
    }));
    assert.deepEqual(readConfig(dir).upstreams, [
        { name: 'ok', baseUrl: 'https://ok.example.com' }
    ]);

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ upstreams: 'nope' }));
    assert.deepEqual(readConfig(dir).upstreams, []);
});

test('readConfig: invalid upstream headers drop only the headers field', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        upstreams: [
            { name: 'a', baseUrl: 'https://a.example.com', headers: { k: 1 } },
            { name: 'b', baseUrl: 'https://b.example.com', headers: ['x'] },
            { name: 'c', baseUrl: 'https://c.example.com', headers: 'no' },
            { name: 'd', baseUrl: 'https://d.example.com', headers: null }
        ]
    }));
    assert.deepEqual(readConfig(dir).upstreams, [
        { name: 'a', baseUrl: 'https://a.example.com' },
        { name: 'b', baseUrl: 'https://b.example.com' },
        { name: 'c', baseUrl: 'https://c.example.com' },
        { name: 'd', baseUrl: 'https://d.example.com' }
    ]);
});

test('writeConfig: upstreams written to disk are preserved verbatim', (t) => {
    const dir = tmpDir(t);
    const upstreams = [
        { name: 'gw2', baseUrl: 'https://gw2.example.com', headers: { 'x-api-key': 'sk-2' } }
    ];
    const out = writeConfig({ upstreams }, dir);
    assert.deepEqual(out.upstreams, upstreams);
    // 再次写其他字段时 upstreams 不被静默丢弃。
    const out2 = writeConfig({ forwardSuggestionMode: true }, dir);
    assert.deepEqual(out2.upstreams, upstreams);
    assert.equal(out2.forwardSuggestionMode, true);
    // normalizeConfig 仍会对回读值做清洗：非法项被移除。
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        forwardSuggestionMode: true,
        upstreams: [{ name: 'gw2', baseUrl: 'https://gw2.example.com' }, { baseUrl: '' }]
    }));
    assert.deepEqual(writeConfig({ forwardSuggestionMode: false }, dir).upstreams, [
        { name: 'gw2', baseUrl: 'https://gw2.example.com' }
    ]);
});

// ---------- usageAlert / alerts.dailyCost ----------

test('readConfig: invalid usageAlert thresholds fall back to defaults as a whole', (t) => {
    const dir = tmpDir(t);
    const invalid = [
        { warnThreshold: 0.9, limitThreshold: 0.8 },   // warn >= limit
        { warnThreshold: 0.8, limitThreshold: 1.2 },   // limit > 1
        { warnThreshold: 0, limitThreshold: 1 },       // warn <= 0
        { warnThreshold: -0.5, limitThreshold: 1 },
        { warnThreshold: '0.8', limitThreshold: 1 },   // 非数值
        { warnThreshold: NaN, limitThreshold: NaN },
        { warnThreshold: 1, limitThreshold: 1 },       // 相等
        null, 'x', 7, [1]
    ];
    for (const usageAlert of invalid) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ usageAlert }));
        assert.deepEqual(readConfig(dir).usageAlert, { warnThreshold: 0.8, limitThreshold: 1 },
            `usageAlert=${JSON.stringify(usageAlert)}`);
    }
});

test('readConfig: valid usageAlert thresholds persist (boundary warn==limit rejected)', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'),
        JSON.stringify({ usageAlert: { warnThreshold: 0.5, limitThreshold: 0.9 } }));
    assert.deepEqual(readConfig(dir).usageAlert, { warnThreshold: 0.5, limitThreshold: 0.9 });
    // limit 恰为 1 合法。
    fs.writeFileSync(path.join(dir, 'config.json'),
        JSON.stringify({ usageAlert: { warnThreshold: 0.6, limitThreshold: 1 } }));
    assert.deepEqual(readConfig(dir).usageAlert, { warnThreshold: 0.6, limitThreshold: 1 });
});

test('readConfig: invalid alerts.dailyCost falls back to 0', (t) => {
    const dir = tmpDir(t);
    for (const dailyCost of [null, '10', 0, -5, Infinity, NaN, []]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ alerts: { dailyCost } }));
        assert.equal(readConfig(dir).alerts.dailyCost, 0, `dailyCost=${JSON.stringify(dailyCost)}`);
    }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ alerts: { dailyCost: 12.5 } }));
    assert.equal(readConfig(dir).alerts.dailyCost, 12.5);
});

test('writeConfig: usageAlert partial merge and alerts.dailyCost survive sibling writes', (t) => {
    const dir = tmpDir(t);
    writeConfig({
        alerts: { dailyCost: 5 },
        usageAlert: { warnThreshold: 0.6, limitThreshold: 0.95 }
    }, dir);
    const out = writeConfig({ thinkingAsText: false }, dir);
    assert.deepEqual(out.alerts, { dailyTokens: 0, dailyCost: 5 });
    assert.deepEqual(out.usageAlert, { warnThreshold: 0.6, limitThreshold: 0.95 });
});
