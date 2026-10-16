// 最近请求日志（tasks.md T8）：内存环形缓冲 200 条，仅元数据（不含请求/
// 响应体），头部摘要 write-time 脱敏后记录；record 后防抖落盘
// ~/.cc-proxy/runtime/recent-requests.json（tmp+rename 原子替换、mode 0600，
// 同 upstream-health.js T4 pattern）。纯观测数据：任何落盘失败静默，
// 绝不阻塞代理转发链路。settings-web 进程只读落盘文件。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 200;
const FLUSH_DEBOUNCE_MS = 500;

// 脱敏目标头（小写匹配）：任务描述指定的认证/会话类头。
const REDACT_KEYS = new Set([
    'authorization',
    'x-api-key',
    'anthropic-api-key',
    'cookie',
    'proxy-authorization',
    'set-cookie'
]);

// 响应头摘要仅记录脱敏后的认证类头值集合（避免记录全部响应头）。
const RESPONSE_SUMMARY_KEYS = ['content-type', 'request-id', 'anthropic-version'];

export function defaultRequestLogPath(envDir) {
    return path.join(envDir || path.join(os.homedir(), '.cc-proxy'), 'runtime', 'recent-requests.json');
}

// 模块内二次校验键名（防御 REDACT_KEYS 被误改/调用方绕过）：仅匹配
// 上述明文键集合，不做模式匹配，杜绝把非敏感头误脱敏。
function isSensitiveKey(lowerKey) {
    return REDACT_KEYS.has(lowerKey);
}

// 单头脱敏：值 >4 位保留 '***'+末 4 位；≤4 位（含空串/缺失）全 '***'，
// 不保留任何原文片段。
export function redactHeaderValue(value) {
    if (typeof value !== 'string' || value.length <= 4) return '***';
    return `***${value.slice(-4)}`;
}

// 头对象脱敏（write-time）：遍历键名，敏感键 → redactHeaderValue，
// 非敏感键原样保留。键名统一小写匹配（HTTP 头大小写不敏感）。
export function redactHeaders(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (const [key, value] of Object.entries(headers)) {
        const lowerKey = String(key).toLowerCase();
        if (isSensitiveKey(lowerKey)) {
            out[lowerKey] = redactHeaderValue(Array.isArray(value) ? value.join(', ') : value);
        } else if (RESPONSE_SUMMARY_KEYS.includes(lowerKey)) {
            out[lowerKey] = typeof value === 'string' ? value : String(value);
        }
        // 其余键不记录（最小化元数据）。
    }
    return out;
}

export function createRequestLogTracker({
    file = defaultRequestLogPath(),
    debounceMs = FLUSH_DEBOUNCE_MS,
    now = () => new Date()
} = {}) {
    const entries = []; // 环形缓冲：超 MAX_ENTRIES 后 shift，恒 ≤200 条
    let flushTimer = null;

    // 请求完成埋点：仅元数据，meta 中 headers 经 write-time 脱敏。
    const record = ({
        upstreamId,
        model = null,
        statusCode = null,
        ttftMs = null,
        thinkingRewritten = false,
        failedOver = false,
        requestHeaders = null,
        responseHeaders = null
    } = {}) => {
        entries.push({
            time: now().toISOString(),
            upstream: typeof upstreamId === 'string' && upstreamId ? upstreamId : null,
            model: typeof model === 'string' && model ? model : null,
            statusCode: Number.isInteger(statusCode) ? statusCode : null,
            ttftMs: Number.isFinite(ttftMs) && ttftMs >= 0 ? ttftMs : null,
            thinkingRewritten: thinkingRewritten === true,
            failedOver: failedOver === true,
            requestHeaders: redactHeaders(requestHeaders),
            responseHeaders: redactHeaders(responseHeaders)
        });
        if (entries.length > MAX_ENTRIES) entries.shift();
        scheduleFlush();
    };

    const getSnapshot = () => ({
        updatedAt: now().toISOString(),
        entries: [...entries]
    });

    // 原子落盘：同 T4 pattern——tmp（wx + mode 0600）+ rename，rename 失败清理 tmp。
    const flushNow = () => {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
            fs.writeFileSync(tempFile, JSON.stringify(getSnapshot(), null, 2) + '\n',
                { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            try {
                fs.renameSync(tempFile, file);
            } catch (renameErr) {
                try { fs.unlinkSync(tempFile); } catch { /* 忽略 */ }
                throw renameErr;
            }
        } catch {
            // 落盘失败不阻塞代理流量。
        }
    };

    // 防抖合并写；unref 防止定时器阻止进程退出。
    const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushNow();
        }, debounceMs);
        flushTimer.unref?.();
    };

    return { record, getSnapshot, flushNow };
}

// 读落盘日志（settings-web 用）：缺失/损坏/结构非法 → 空快照，绝不抛出。
export function readRequestLog(file = defaultRequestLogPath()) {
    const empty = { updatedAt: null, entries: [] };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
        const entries = Array.isArray(raw.entries)
            ? raw.entries.filter((e) => e && typeof e === 'object' && !Array.isArray(e))
            : [];
        return { updatedAt: raw.updatedAt ?? null, entries };
    } catch {
        return empty;
    }
}
