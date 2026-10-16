// request-log 测试（tasks.md T8）：脱敏单元测试（含缺失头、短值边界、
// 落盘文件无原文）+ 环形覆盖测试（201 条后恒 200）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createRequestLogTracker,
    readRequestLog,
    redactHeaderValue,
    redactHeaders,
    defaultRequestLogPath
} from '../src/request-log.js';

function tmpFile(t, name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-reqlog-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, name);
}

// 固定 UTC 时钟：避免本地时区差异导致 toISOString 断言在非 UTC+8 环境失败。
const now = () => new Date('2026-10-16T10:00:00Z');

// ---------- redactHeaderValue / redactHeaders ----------

test('redactHeaderValue: 长值保留末 4 位，短值/缺失全 ***', () => {
    assert.equal(redactHeaderValue('sk-ant-abc123XYZ'), '***3XYZ');
    assert.equal(redactHeaderValue('abcde'), '***bcde');
    assert.equal(redactHeaderValue('abcd'), '***'); // 恰 4 位：全 ***
    assert.equal(redactHeaderValue('abc'), '***');
    assert.equal(redactHeaderValue(''), '***');
    assert.equal(redactHeaderValue(null), '***');
    assert.equal(redactHeaderValue(undefined), '***');
    assert.equal(redactHeaderValue(12345), '***');
});

test('redactHeaders: 敏感键脱敏、键名大小写不敏感、二次校验兜底', () => {
    const out = redactHeaders({
        Authorization: 'Bearer sk-ant-secretTOKEN',
        'x-api-key': 'sk-1234567890',
        'ANTHROPIC-API-KEY': 'k-abcdefghij',
        Cookie: 'session=longsessionvalue',
        'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
        'Set-Cookie': ['a=1', 'b=2']
    });
    assert.deepEqual(out, {
        authorization: '***OKEN',
        'x-api-key': '***7890',
        'anthropic-api-key': '***ghij',
        cookie: '***alue',
        'proxy-authorization': '***YXNz',
        'set-cookie': '*** b=2'
    });
});

test('redactHeaders: 非敏感键仅记录白名单摘要键，其余丢弃', () => {
    const out = redactHeaders({
        'content-type': 'text/event-stream',
        'request-id': 'req_123',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-cli/1.0', // 非白名单：丢弃
        'x-custom': 'anything'
    });
    assert.deepEqual(out, {
        'content-type': 'text/event-stream',
        'request-id': 'req_123',
        'anthropic-version': '2023-06-01'
    });
});

test('redactHeaders: null/非对象/空对象 → 空对象', () => {
    assert.deepEqual(redactHeaders(null), {});
    assert.deepEqual(redactHeaders(undefined), {});
    assert.deepEqual(redactHeaders('str'), {});
    assert.deepEqual(redactHeaders({}), {});
});

// ---------- 环形缓冲 ----------

test('request-log: 环形覆盖 — 201 条后恒 200 条，最旧被淘汰', (t) => {
    const tracker = createRequestLogTracker({ file: tmpFile(t, 'log.json'), now });
    for (let i = 1; i <= 201; i++) {
        tracker.record({ upstreamId: 'up', statusCode: 200, model: `m${i}` });
    }
    const snap = tracker.getSnapshot();
    assert.equal(snap.entries.length, 200);
    // 最旧的 m1 被淘汰，保留 m2..m201。
    assert.equal(snap.entries[0].model, 'm2');
    assert.equal(snap.entries[199].model, 'm201');
});

test('request-log: record 元数据归一化（非法值 → null/false）', (t) => {
    const tracker = createRequestLogTracker({ file: tmpFile(t, 'log.json'), now });
    tracker.record({
        upstreamId: 'api.anthropic.com',
        model: 'claude-sonnet-5',
        statusCode: 200,
        ttftMs: 123.4,
        thinkingRewritten: 'yes', // 非 boolean → false
        failedOver: 1, // 非 boolean → false
        requestHeaders: { Authorization: 'Bearer tok-secretWXYZ' }
    });
    const e = tracker.getSnapshot().entries[0];
    assert.equal(e.time, '2026-10-16T10:00:00.000Z');
    assert.equal(e.upstream, 'api.anthropic.com');
    assert.equal(e.ttftMs, 123.4);
    assert.equal(e.thinkingRewritten, false);
    assert.equal(e.failedOver, false);
    assert.equal(e.requestHeaders.authorization, '***WXYZ');
});

// ---------- 落盘 ----------

test('request-log: 防抖落盘 + 落盘文件无敏感原文 + readRequestLog 回读', async (t) => {
    const file = tmpFile(t, 'recent-requests.json');
    const tracker = createRequestLogTracker({ file, debounceMs: 20, now });
    tracker.record({
        upstreamId: 'api.anthropic.com',
        statusCode: 200,
        requestHeaders: {
            Authorization: 'Bearer sk-ant-SECRETVALUE99',
            'x-api-key': 'key'
        }
    });
    // 防抖窗口内文件尚不存在。
    assert.equal(fs.existsSync(file), false);
    // 轮询等待落盘，避免事件循环阻塞时固定 sleep 余量不足的竞态。
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) {
        await new Promise((r) => setTimeout(r, 10));
    }

    const raw = fs.readFileSync(file, 'utf8');
    // 落盘文件不含任何敏感原文。
    assert.ok(!raw.includes('SECRETVALUE99'), '落盘文件不得包含原始 token');
    assert.ok(!raw.includes('sk-ant'), '落盘文件不得包含 token 前缀');
    assert.ok(raw.includes('***UE99'));

    const log = readRequestLog(file);
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].upstream, 'api.anthropic.com');
    assert.equal(log.entries[0].requestHeaders.authorization, '***UE99');
    assert.equal(log.entries[0].requestHeaders['x-api-key'], '***');
});

test('request-log: flushNow 立即落盘（不等防抖）', (t) => {
    const file = tmpFile(t, 'flush.json');
    const tracker = createRequestLogTracker({ file, debounceMs: 60_000, now });
    tracker.record({ upstreamId: 'u' });
    tracker.flushNow();
    assert.equal(fs.existsSync(file), true);
    assert.equal(readRequestLog(file).entries.length, 1);
});

test('request-log: 落盘文件 mode 0600（tmp+rename 原子替换）', (t) => {
    const file = tmpFile(t, 'mode.json');
    const tracker = createRequestLogTracker({ file, now });
    tracker.record({ upstreamId: 'u' });
    tracker.flushNow();
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
});

test('request-log: 落盘失败静默不抛出（目录不可写）', (t) => {
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root 下 chmod 不生效
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-ro-'));
    t.after(() => { try { fs.chmodSync(dir, 0o700); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
    fs.chmodSync(dir, 0o500);
    const tracker = createRequestLogTracker({
        file: path.join(dir, 'runtime', 'log.json'), now
    });
    assert.doesNotThrow(() => tracker.record({ upstreamId: 'u' }));
    assert.doesNotThrow(() => tracker.flushNow());
    // 静默失败路径可观察：落盘文件确实未生成。
    assert.equal(fs.existsSync(path.join(dir, 'runtime', 'log.json')), false);
});

test('readRequestLog: 缺失/损坏/结构非法 → 空快照', (t) => {
    assert.deepEqual(readRequestLog(tmpFile(t, 'missing.json')), { updatedAt: null, entries: [] });
    const bad = tmpFile(t, 'bad.json');
    fs.writeFileSync(bad, '{not json', { mode: 0o600 });
    assert.deepEqual(readRequestLog(bad), { updatedAt: null, entries: [] });
    const arr = tmpFile(t, 'arr.json');
    fs.writeFileSync(arr, '[1,2]', { mode: 0o600 });
    assert.deepEqual(readRequestLog(arr), { updatedAt: null, entries: [] });
    const junkEntries = tmpFile(t, 'junk.json');
    fs.writeFileSync(junkEntries, JSON.stringify({ updatedAt: 'x', entries: [null, 's', { upstream: 'u' }] }), { mode: 0o600 });
    const log = readRequestLog(junkEntries);
    assert.equal(log.updatedAt, 'x');
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].upstream, 'u');
});

test('defaultRequestLogPath: 默认 ~/.cc-proxy/runtime，envDir 可注入', () => {
    const home = os.homedir();
    assert.equal(defaultRequestLogPath(), path.join(home, '.cc-proxy', 'runtime', 'recent-requests.json'));
    assert.equal(defaultRequestLogPath('/tmp/env'), path.join('/tmp/env', 'runtime', 'recent-requests.json'));
});
