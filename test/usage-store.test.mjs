// usage-store 双模式对照测试（tasks.md T6）：
// 同一 record 输入 → readRecentDays / summary 结构一致；sqliteModule 注入控制模式选择。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageStore } from '../src/usage-store.js';

let sqliteModule = null;
try {
    sqliteModule = await import('node:sqlite');
} catch {
    // 环境不支持 node:sqlite：SQLite 分支测试自动跳过
}

function tmpFile(t, name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-store-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, name);
}

// 两个 store 使用相同的固定时钟，保证 day/hour key 与 readRecentDays 日界一致。
const FIXED = new Date(2026, 9, 15, 10, 30, 0);
const now = () => new Date(FIXED);

const SAMPLES = [
    { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 5 }, model: 'claude-sonnet-5' },
    { usage: { inputTokens: 5 }, model: 'claude-sonnet-5' },
    { usage: { inputTokens: 1, cacheReadTokens: 7 }, model: 'claude-haiku-4-5' },
    { usage: { bogus: -3, inputTokens: 0 }, model: null } // 非法值按 0、model 归 unknown
];

function recordSamples(store) {
    for (const { usage, model } of SAMPLES) store.record(usage, model);
}

test('usage-store: sqlite 模式 record/summary/readRecentDays 基本行为', { skip: !sqliteModule }, async (t) => {
    const store = await createUsageStore({
        file: tmpFile(t, 'usage.db'),
        now,
        sqliteModule
    });
    assert.equal(store.mode, 'sqlite');

    recordSamples(store);
    const s = store.summary();
    assert.equal(s.day, '2026-10-15');
    assert.equal(s.requests, 4);
    assert.equal(s.inputTokens, 16);
    assert.equal(s.outputTokens, 20);
    assert.equal(s.cacheReadTokens, 7);
    assert.equal(s.cacheCreationTokens, 5);
    assert.equal(s.persisted, true);
    assert.deepEqual(s.byModel['claude-sonnet-5'], {
        requests: 2, inputTokens: 15, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 5
    });
    assert.deepEqual(s.byModel.unknown, {
        requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0
    });
});

test('usage-store: 两模式对照 — 同一输入 summary/readRecentDays 结构一致', async (t) => {
    const jsonStore = await createUsageStore({
        file: tmpFile(t, 'usage.json'),
        now,
        sqliteModule: null
    });
    assert.equal(jsonStore.mode, 'json');
    recordSamples(jsonStore);

    const days = jsonStore.readRecentDays(3);
    assert.equal(days.length, 3);
    assert.equal(days[0].date, '2026-10-15');
    assert.equal(days[0].requests, 4);
    assert.equal(days[0].inputTokens, 16);
    assert.ok(Object.getPrototypeOf(days[0].byModel) === null);

    if (!sqliteModule) {
        // 环境不支持 node:sqlite 时仅验证 JSON 分支后提前结束。
        return;
    }
    const sqliteStore = await createUsageStore({
        file: tmpFile(t, 'usage.db'),
        now,
        sqliteModule
    });
    assert.equal(sqliteStore.mode, 'sqlite');
    recordSamples(sqliteStore);

    // 结构对照：字段集合一致（persisted 语义不同：json=false/sqlite=true）。
    const js = jsonStore.summary();
    const ss = sqliteStore.summary();
    assert.deepEqual(Object.keys(js).sort(), Object.keys(ss).sort());
    for (const key of ['day', 'requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) {
        assert.deepEqual(ss[key], js[key], `summary.${key} 不一致`);
    }
    assert.deepEqual(ss.byModel, js.byModel);

    const jd = jsonStore.readRecentDays(3);
    const sd = sqliteStore.readRecentDays(3);
    assert.equal(sd.length, jd.length);
    for (let i = 0; i < jd.length; i++) {
        assert.deepEqual(Object.keys(sd[i]).sort(), Object.keys(jd[i]).sort());
        for (const key of ['date', 'requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) {
            assert.deepEqual(sd[i][key], jd[i][key], `readRecentDays[${i}].${key} 不一致`);
        }
        assert.deepEqual(sd[i].byModel, jd[i].byModel);
    }
    // 今天的记录在 days[0]。
    assert.equal(sd[0].date, '2026-10-15');
    assert.equal(sd[0].requests, 4);
});

test('usage-store: sqliteModule=null 强制 JSON 且 record 复用 tracker 落盘', async (t) => {
    const file = tmpFile(t, 'usage.json');
    const store = await createUsageStore({ file, now, sqliteModule: null });
    assert.equal(store.mode, 'json');
    store.record({ inputTokens: 3 }, 'm');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // usage.js 落盘格式：{ 'YYYY-MM-DD': day }，day 顶层含累计字段。
    assert.equal(raw['2026-10-15'].inputTokens, 3);
    assert.equal(raw['2026-10-15'].requests, 1);
});

test('usage-store: readRecentDays 非法天数返回空数组', async (t) => {
    const store = await createUsageStore({
        file: tmpFile(t, 'usage.db'),
        now,
        sqliteModule: null
    });
    assert.deepEqual(store.readRecentDays(0), []);
    assert.deepEqual(store.readRecentDays(-1), []);
});

test('usage-store: sqlite 打开失败（目录不可写）回退 JSON 模式', async (t) => {
    if (process.platform === 'win32') return; // 权限模型不同，跳过
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-ro-'));
    t.after(() => { try { fs.chmodSync(dir, 0o700); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
    fs.chmodSync(dir, 0o500); // 只读目录：DatabaseSync 打开子文件失败
    const store = await createUsageStore({
        file: path.join(dir, 'usage.db'),
        now,
        sqliteModule: sqliteModule || undefined
    });
    assert.equal(store.mode, 'json');
});

test('usage-store: sqlite record 运行期失败静默容错，不抛出（CR #1）', { skip: !sqliteModule }, async (t) => {
    // 桩：open 成功但 run 抛错，模拟运行期事务失败。
    const throwing = {
        DatabaseSync: class {
            constructor() {}
            exec() {}
            prepare() {
                return {
                    run: () => { throw new Error('disk I/O error'); },
                    get: () => null,
                    all: () => []
                };
            }
        }
    };
    const store = await createUsageStore({
        file: tmpFile(t, 'usage.db'),
        now,
        sqliteModule: throwing
    });
    assert.equal(store.mode, 'sqlite');
    assert.doesNotThrow(() => store.record({ inputTokens: 3 }, 'm'));
    // 失败后统计回退空值而非崩溃。
    assert.equal(store.summary().requests, 0);
});

test('usage-store: record 失败时 CC_PROXY_DEBUG 通道落盘错误行', { skip: !sqliteModule }, async (t) => {
    const dbgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-dbg-'));
    t.after(() => fs.rmSync(dbgDir, { recursive: true, force: true }));
    process.env.CC_PROXY_DEBUG = '1';
    t.after(() => { delete process.env.CC_PROXY_DEBUG; });
    const throwing = {
        DatabaseSync: class {
            constructor() {}
            exec() {}
            prepare() {
                return {
                    run: () => { throw new Error('disk I/O error'); },
                    get: () => null,
                    all: () => []
                };
            }
        }
    };
    const store = await createUsageStore({
        file: tmpFile(t, 'usage.db'),
        now,
        sqliteModule: throwing,
        debugDir: dbgDir
    });
    assert.equal(store.mode, 'sqlite');
    store.record({ inputTokens: 3 }, 'm');
    const content = fs.readFileSync(path.join(dbgDir, 'usage-store.log'), 'utf8');
    assert.ok(content.includes('record failed: disk I/O error'));
});
