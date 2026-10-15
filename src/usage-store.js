// 用量存储抽象层：统一 JSON / SQLite 双模式的读写接口（design D1）。
// - 探测：动态 import('node:sqlite') + DatabaseSync 存在性检测，不依赖版本号；
//   sqliteModule 参数可注入（null 强制 JSON 模式；传桩模块验证 SQLite 路径，不依赖运行环境）。
// - SQLite 模式：WAL + busy_timeout=5000；usage_daily / usage_by_model / usage_hourly
//   三表（小时粒度本期仅落盘，API 不暴露，为后续排障分析预留）。
// - JSON 模式：委托现有 createUsageTracker / readRecentDays，避免行为分叉。
// 容错策略与 usage.js 一致：任何失败不抛出、不阻塞代理流量。
import fs from 'node:fs';
import path from 'node:path';
import {
    createUsageTracker,
    readRecentDays,
    defaultUsagePath
} from './usage.js';
import { isDebugEnabled, defaultDebugLogDir } from './debug-log.js';

const NUM_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];

// JS 驼峰字段 → 表列名（snake_case）：inputTokens → input_tokens。
const SQL_COLUMNS = {
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    cacheReadTokens: 'cache_read_tokens',
    cacheCreationTokens: 'cache_creation_tokens'
};

// 按本地自然日/小时 key（与 usage.js dayKey 同口径：本地时区，用户直觉的"今天"）。
function dayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function hourKey(date) {
    return `${dayKey(date)}T${String(date.getHours()).padStart(2, '0')}`;
}

// 仅接受正整数（与 usage.js 逐字段校验同口径），非法按 0。
function posInt(v) {
    return Number.isInteger(v) && v > 0 ? v : 0;
}

let cachedSqlite; // 探测结果进程内缓存：undefined 未探测，null 不可用，否则为模块

async function detectSqlite() {
    if (cachedSqlite !== undefined) return cachedSqlite;
    try {
        const mod = await import('node:sqlite');
        cachedSqlite = mod && typeof mod.DatabaseSync === 'function' ? mod : null;
    } catch {
        cachedSqlite = null;
    }
    return cachedSqlite;
}

// ---------- SQLite 模式 ----------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_daily (
    date TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_by_model (
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, model)
);
CREATE TABLE IF NOT EXISTS usage_hourly (
    hour TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0
);
`;

// 逐表累加 upsert：ON CONFLICT 对各计数字段做加法合并（键列除外）。
function upsertSql(table, keyCols) {
    const cols = [...keyCols, 'requests', ...NUM_FIELDS.map((f) => SQL_COLUMNS[f])];
    const placeholders = cols.map(() => '?').join(', ');
    const adds = cols
        .filter((c) => !keyCols.includes(c))
        .map((c) => `${c} = ${c} + excluded.${c}`)
        .join(', ');
    return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
        ON CONFLICT(${keyCols.join(', ')}) DO UPDATE SET ${adds}`;
}

function openSqliteDb(DatabaseSync, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    return db;
}

function createSqliteStore({ DatabaseSync, file, now, debugDir = defaultDebugLogDir() }) {
    const db = openSqliteDb(DatabaseSync, file);
    // record 静默容错后无其他观测出口，接入 CC_PROXY_DEBUG 落盘通道便于排查。
    const dbgEnabled = isDebugEnabled();
    const dbgLine = dbgEnabled
        ? (line) => {
            try {
                fs.mkdirSync(debugDir, { recursive: true });
                fs.appendFileSync(path.join(debugDir, 'usage-store.log'), line + '\n', { mode: 0o600 });
            } catch { /* debug 落盘失败静默 */ }
        }
        : null;
    const recordDaily = db.prepare(upsertSql('usage_daily', ['date']));
    const recordByModel = db.prepare(upsertSql('usage_by_model', ['date', 'model']));
    const recordHourly = db.prepare(upsertSql('usage_hourly', ['hour']));

    const record = (usage, model) => {
        if (!usage) return;
        const stamp = now();
        // 与 usage.js 同口径：逐字段正整数校验，非法按 0。
        const values = NUM_FIELDS.map((f) => posInt(usage[f]));
        const modelKey = typeof model === 'string' && model ? model : 'unknown';
        // 单事务：三表原子累加，中途失败回滚不留半写状态；
        // 落盘失败不阻塞代理流量（与 usage.js 容错策略一致），静默吞掉。
        try {
            db.exec('BEGIN');
            recordDaily.run(dayKey(stamp), 1, ...values);
            recordByModel.run(dayKey(stamp), modelKey, 1, ...values);
            recordHourly.run(hourKey(stamp), 1, ...values);
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch { /* 事务已被自动回滚 */ }
            dbgLine?.(`# ${now().toISOString()} record failed: ${err?.message}`);
        }
    };

    // 近 days 天（含今天，本地日界倒推）的归一化统计数组，形状与
    // usage.js readRecentDays 逐字段一致（byModel 为 null 原型对象）。
    const readDays = (days) => {
        if (!Number.isInteger(days) || days < 1) return [];
        const base = now();
        const byModelRows = db.prepare(
            'SELECT date, model, requests, input_tokens, output_tokens, '
            + 'cache_read_tokens, cache_creation_tokens FROM usage_by_model '
            + 'WHERE date >= ? ORDER BY date'
        );
        const minDate = dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - (days - 1)));
        const modelsByDate = new Map();
        for (const row of byModelRows.all(minDate)) {
            if (!modelsByDate.has(row.date)) modelsByDate.set(row.date, Object.create(null));
            modelsByDate.get(row.date)[row.model] = {
                requests: row.requests,
                inputTokens: row.input_tokens,
                outputTokens: row.output_tokens,
                cacheReadTokens: row.cache_read_tokens,
                cacheCreationTokens: row.cache_creation_tokens
            };
        }
        const dailyRows = db.prepare(
            'SELECT date, requests, input_tokens, output_tokens, '
            + 'cache_read_tokens, cache_creation_tokens FROM usage_daily WHERE date >= ?'
        ).all(minDate);
        const byDate = new Map(dailyRows.map((row) => [row.date, row]));
        const out = [];
        for (let i = 0; i < days; i++) {
            const key = dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i));
            const row = byDate.get(key);
            out.push({
                date: key,
                requests: row ? row.requests : 0,
                inputTokens: row ? row.input_tokens : 0,
                outputTokens: row ? row.output_tokens : 0,
                cacheReadTokens: row ? row.cache_read_tokens : 0,
                cacheCreationTokens: row ? row.cache_creation_tokens : 0,
                byModel: modelsByDate.get(key) ?? Object.create(null)
            });
        }
        return out;
    };

    const summary = () => {
        const key = dayKey(now());
        const row = db.prepare(
            'SELECT requests, input_tokens, output_tokens, '
            + 'cache_read_tokens, cache_creation_tokens FROM usage_daily WHERE date = ?'
        ).get(key);
        const byModel = Object.create(null);
        for (const entry of db.prepare(
            'SELECT model, requests, input_tokens, output_tokens, '
            + 'cache_read_tokens, cache_creation_tokens FROM usage_by_model WHERE date = ?'
        ).all(key)) {
            byModel[entry.model] = {
                requests: entry.requests,
                inputTokens: entry.input_tokens,
                outputTokens: entry.output_tokens,
                cacheReadTokens: entry.cache_read_tokens,
                cacheCreationTokens: entry.cache_creation_tokens
            };
        }
        return {
            day: key,
            requests: row ? row.requests : 0,
            inputTokens: row ? row.input_tokens : 0,
            outputTokens: row ? row.output_tokens : 0,
            cacheReadTokens: row ? row.cache_read_tokens : 0,
            cacheCreationTokens: row ? row.cache_creation_tokens : 0,
            byModel,
            persisted: true
        };
    };

    return { mode: 'sqlite', record, readRecentDays: readDays, summary };
}

// ---------- 工厂 ----------

export async function createUsageStore({
    file = defaultUsagePath(),
    now = () => new Date(),
    sqliteModule, // 测试注入：undefined=自动探测，null=强制 JSON，对象=桩模块
    debugDir // CC_PROXY_DEBUG 落盘目录（测试注入用）
} = {}) {
    let mod = sqliteModule;
    if (mod === undefined) mod = await detectSqlite();
    if (mod && typeof mod.DatabaseSync === 'function') {
        try {
            return createSqliteStore({ DatabaseSync: mod.DatabaseSync, file, now, debugDir });
        } catch {
            // SQLite 打开/建表失败（如文件系统问题）→ 回退 JSON，行为不分叉。
        }
    }
    // JSON 模式：委托现有 tracker（record/summary 同签名；readRecentDays 复用现有实现）。
    const tracker = createUsageTracker({ usageFile: file, now });
    return {
        mode: 'json',
        record: tracker.record,
        readRecentDays: (days) => readRecentDays(file, days, now),
        summary: tracker.summary
    };
}
