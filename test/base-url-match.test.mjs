import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeBaseUrl,
    buildBaseUrlTargetSet,
    isBaseUrlTargetHit,
    buildBaseUrlTargetEntries,
    resolveBaseUrlTargetValue
} from '../src/base-url-match.js';

// 本模块为定向匹配的单一实现，usageScale 与 effortOverride 两个定向特性
// 共用（proxy 侧从同一模块导入），故此处断言即两处共用的行为契约。

// ---------- normalizeBaseUrl ----------

test('normalizeBaseUrl: trailing slash stripped, default port normalized', () => {
    assert.equal(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com:443');
    assert.equal(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com:443');
    assert.equal(normalizeBaseUrl('http://gw.local:8080/'), 'http://gw.local:8080');
    // 显式端口保留；路径保留（含多段）。
    assert.equal(normalizeBaseUrl('https://gw.example.com:8443/api/'), 'https://gw.example.com:8443/api');
    assert.equal(normalizeBaseUrl('https://gw.example.com/api/v1'), 'https://gw.example.com:443/api/v1');
    // 重复尾斜杠全部剥离（"//" 不得残留为路径 "/"）。
    assert.equal(normalizeBaseUrl('https://gw.example.com/api//'), 'https://gw.example.com:443/api');
    assert.equal(normalizeBaseUrl('https://gw.example.com///'), 'https://gw.example.com:443');
});

test('normalizeBaseUrl: invalid input returns null', () => {
    assert.equal(normalizeBaseUrl(null), null);
    assert.equal(normalizeBaseUrl(42), null);
    assert.equal(normalizeBaseUrl(''), null);
    assert.equal(normalizeBaseUrl('not a url'), null);
    // 非 http/https 协议不接受。
    assert.equal(normalizeBaseUrl('ftp://api.example.com'), null);
    assert.equal(normalizeBaseUrl('file:///etc/passwd'), null);
});

// ---------- buildBaseUrlTargetSet ----------

test('buildBaseUrlTargetSet: empty / non-array / all-invalid input returns null', () => {
    assert.equal(buildBaseUrlTargetSet([]), null);
    assert.equal(buildBaseUrlTargetSet(null), null);
    assert.equal(buildBaseUrlTargetSet('https://x'), null);
    assert.equal(buildBaseUrlTargetSet(['::bad::', 42]), null);
});

test('buildBaseUrlTargetSet: valid items normalized into a Set, invalid dropped', () => {
    const set = buildBaseUrlTargetSet(['https://a.com/', 'https://b.com:9443/api', '::bad::']);
    assert.ok(set instanceof Set);
    assert.equal(set.size, 2);
    assert.ok(set.has('https://a.com:443'));
    assert.ok(set.has('https://b.com:9443/api'));
});

// ---------- isBaseUrlTargetHit ----------

test('isBaseUrlTargetHit: empty target path covers all paths of the origin', () => {
    const set = buildBaseUrlTargetSet(['https://a.com']);
    assert.ok(isBaseUrlTargetHit('https://a.com:443', set));
    assert.ok(isBaseUrlTargetHit('https://a.com:443/anything', set));
    assert.ok(isBaseUrlTargetHit('https://a.com:443/api/v1', set));
    assert.ok(!isBaseUrlTargetHit('https://other.com:443', set));
});

test('isBaseUrlTargetHit: segment-prefix match, cross-segment rejected', () => {
    const set = buildBaseUrlTargetSet(['https://a.com/api']);
    assert.ok(isBaseUrlTargetHit('https://a.com:443/api', set));
    assert.ok(isBaseUrlTargetHit('https://a.com:443/api/v2/messages', set));
    assert.ok(!isBaseUrlTargetHit('https://a.com:443', set));
    assert.ok(!isBaseUrlTargetHit('https://a.com:443/apiv2', set));
    assert.ok(!isBaseUrlTargetHit('https://a.com:443/api-x', set));
});

test('isBaseUrlTargetHit: port and protocol must match exactly after normalization', () => {
    const set = buildBaseUrlTargetSet(['http://a.com:8080']);
    assert.ok(isBaseUrlTargetHit('http://a.com:8080/', set));
    assert.ok(!isBaseUrlTargetHit('http://a.com:80', set));
    assert.ok(!isBaseUrlTargetHit('https://a.com:443', set));
});

test('isBaseUrlTargetHit: missing inputs never hit', () => {
    const set = buildBaseUrlTargetSet(['https://a.com']);
    assert.ok(!isBaseUrlTargetHit(null, set));
    assert.ok(!isBaseUrlTargetHit('', set));
    assert.ok(!isBaseUrlTargetHit('https://a.com:443', null));
});

// ---------- buildBaseUrlTargetEntries / resolveBaseUrlTargetValue ----------
// 条目形态供 effortOverride 使用：命中后还要取该条目自带的档位值。

test('buildBaseUrlTargetEntries: empty / non-array / all-invalid input returns null', () => {
    assert.equal(buildBaseUrlTargetEntries([]), null);
    assert.equal(buildBaseUrlTargetEntries(null), null);
    assert.equal(buildBaseUrlTargetEntries([{ url: '::bad::' }, { url: 42 }]), null);
});

test('buildBaseUrlTargetEntries: sorted by path length descending (longest prefix first)', () => {
    const entries = buildBaseUrlTargetEntries([
        { url: 'https://a.com', value: 'low' },
        { url: 'https://a.com/api/v2', value: 'max' },
        { url: 'https://a.com/api', value: 'high' }
    ]);
    assert.deepEqual(entries.map((e) => e.base), [
        'https://a.com:443/api/v2',
        'https://a.com:443/api',
        'https://a.com:443'
    ]);
});

test('buildBaseUrlTargetEntries: duplicate normalized URL keeps first occurrence value', () => {
    // 尾斜杠归一后视为同一 URL：后项的 'max' 被丢弃，保留首项的 null。
    const entries = buildBaseUrlTargetEntries([
        { url: 'https://a.com', value: null },
        { url: 'https://a.com/', value: 'max' }
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].base, 'https://a.com:443');
    assert.equal(entries[0].value, null);
});

test('buildBaseUrlTargetEntries: undefined value normalized to null', () => {
    const entries = buildBaseUrlTargetEntries([{ url: 'https://a.com' }]);
    assert.equal(entries[0].value, null);
});

test('resolveBaseUrlTargetValue: longest prefix wins, three-state result', () => {
    const entries = buildBaseUrlTargetEntries([
        { url: 'https://a.com', value: 'low' },
        { url: 'https://a.com/api', value: 'max' }
    ]);
    // 最长前缀优先：/api/v2 命中更深层的 /api 条目。
    assert.equal(resolveBaseUrlTargetValue('https://a.com:443/api/v2', entries), 'max');
    // 更浅路径回落浅层条目。
    assert.equal(resolveBaseUrlTargetValue('https://a.com:443/other', entries), 'low');
    // 未命中 → undefined（调用方不覆写）。
    assert.equal(resolveBaseUrlTargetValue('https://b.com:443', entries), undefined);
    // 命中但条目未指定值 → null（调用方回退全局值）。
    const unspecified = buildBaseUrlTargetEntries([{ url: 'https://a.com' }]);
    assert.equal(resolveBaseUrlTargetValue('https://a.com:443/x', unspecified), null);
});

test('resolveBaseUrlTargetValue: missing inputs never hit', () => {
    const entries = buildBaseUrlTargetEntries([{ url: 'https://a.com', value: 'low' }]);
    assert.equal(resolveBaseUrlTargetValue(null, entries), undefined);
    assert.equal(resolveBaseUrlTargetValue('', entries), undefined);
    assert.equal(resolveBaseUrlTargetValue('https://a.com:443', null), undefined);
});

test('entry form and set form agree on hit semantics', () => {
    const urls = ['https://a.com', 'https://a.com/api', 'http://b.com:8080'];
    const set = buildBaseUrlTargetSet(urls);
    const entries = buildBaseUrlTargetEntries(urls.map((url) => ({ url })));
    const bases = [
        'https://a.com:443', 'https://a.com:443/api', 'https://a.com:443/api/v1',
        'https://a.com:443/apiv2', 'https://a.com:443/api-x',
        'http://b.com:8080/x', 'http://b.com:80', 'https://c.com:443'
    ];
    for (const base of bases) {
        assert.equal(isBaseUrlTargetHit(base, set),
            resolveBaseUrlTargetValue(base, entries) !== undefined,
            `hit semantics diverged for ${base}`);
    }
});