// usage-store 双模式对照测试（tasks.md T6）：
// 同一 record 输入 → readRecentDays / summary 结构一致；sqliteModule 注入控制模式选择。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageStore, importJsonHistory } from '../src/usage-store.js';

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
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root 下 chmod 不生效
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

// ---------- importJsonHistory（tasks.md T7）----------

// 构造历史 usage.json 内容（usage.js 落盘格式：{ 'YYYY-MM-DD': day }）。
function writeHistory(file, days) {
    fs.writeFileSync(file, JSON.stringify(days), { mode: 0o600 });
}

test('importJsonHistory: 历史 usage.json 单事务导入 SQLite 并 rename .imported', { skip: !sqliteModule }, async (t) => {
    const file = tmpFile(t, 'usage.json');
    const dbFile = tmpFile(t, 'usage.db');
    writeHistory(file, {
        '2026-10-01': {
            requests: 2, inputTokens: 10, outputTokens: 20,
            cacheReadTokens: 3, cacheCreationTokens: 1,
            byModel: {
                'claude-sonnet-5': {
                    requests: 2, inputTokens: 10, outputTokens: 20,
                    cacheReadTokens: 3, cacheCreationTokens: 1
                }
            }
        },
        '2026-10-02': { requests: 1, inputTokens: 5 }, // 缺失字段按 0
        'bogus-day': null // 非法日条目跳过（normalizeDayCompat → null）
    });

    const result = await importJsonHistory({ file, dbFile, sqliteModule, now });
    assert.deepEqual(result, { ok: true, imported: 2 });
    // 原文件已改名为 .imported 备份。
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(`${file}.imported`), true);

    // 导入结果经 SQLite 可查：与既有 store 读路径同源（同一 dbFile 打开）。
    const store = await createUsageStore({ file: dbFile, now, sqliteModule });
    assert.equal(store.mode, 'sqlite');
    const days = store.readRecentDays(30);
    const oct1 = days.find((d) => d.date === '2026-10-01');
    assert.ok(oct1, '2026-10-01 应在近 30 天内（FIXED=2026-10-15）');
    assert.equal(oct1.requests, 2);
    assert.equal(oct1.inputTokens, 10);
    assert.equal(oct1.outputTokens, 20);
    assert.equal(oct1.cacheReadTokens, 3);
    assert.equal(oct1.cacheCreationTokens, 1);
    assert.equal(oct1.byModel['claude-sonnet-5'].requests, 2);
    const oct2 = days.find((d) => d.date === '2026-10-02');
    assert.equal(oct2.requests, 1);
    assert.equal(oct2.inputTokens, 5);
});

test('importJsonHistory: 事务失败注入 → 原文件保留、返回 ok:false', { skip: !sqliteModule }, async (t) => {
    const file = tmpFile(t, 'usage.json');
    const history = { '2026-10-01': { requests: 1, inputTokens: 7 } };
    writeHistory(file, history);

    // 桩：db.exec 在 COMMIT（第二次 exec）时抛错，模拟事务提交失败。
    let execCount = 0;
    const failing = {
        DatabaseSync: class {
            exec(sql) {
                execCount += 1;
                if (execCount >= 3) throw new Error('COMMIT failed'); // SCHEMA/PRAGMA 后的 BEGIN/COMMIT
            }
            prepare() {
                return {
                    run: () => {},
                    get: () => null,
                    all: () => []
                };
            }
        }
    };
    const result = await importJsonHistory({ file, sqliteModule: failing, now });
    assert.deepEqual(result, { ok: false, imported: 0 });
    // 原文件保留、未生成 .imported。
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(`${file}.imported`), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), history);
});

test('importJsonHistory: JSON 模式直通（sqliteModule=null / 文件缺失 / 损坏）', async (t) => {
    // sqliteModule=null：无可导入目标，视为成功。
    assert.deepEqual(
        await importJsonHistory({ file: tmpFile(t, 'a.json'), sqliteModule: null, now }),
        { ok: true, imported: 0 }
    );
    // 文件缺失：无可导入数据，不算失败。
    assert.deepEqual(
        await importJsonHistory({
            file: tmpFile(t, 'missing.json'), sqliteModule, now
        }),
        { ok: true, imported: 0 }
    );
    // 损坏 JSON：读不出结构 → null → 直通。
    const bad = tmpFile(t, 'bad.json');
    fs.writeFileSync(bad, '{not json', { mode: 0o600 });
    assert.deepEqual(
        await importJsonHistory({ file: bad, sqliteModule, now }),
        { ok: true, imported: 0 }
    );
});

test('importJsonHistory: SQLite 打不开 → ok:false 且原文件保留', { skip: !sqliteModule }, async (t) => {
    const file = tmpFile(t, 'usage.json');
    writeHistory(file, { '2026-10-01': { requests: 1 } });
    // 桩：DatabaseSync 构造即抛错（打开失败路径）。
    const broken = {
        DatabaseSync: class {
            constructor() { throw new Error('cannot open'); }
        }
    };
    const result = await importJsonHistory({ file, sqliteModule: broken, now });
    assert.deepEqual(result, { ok: false, imported: 0 });
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(`${file}.imported`), false);
});
