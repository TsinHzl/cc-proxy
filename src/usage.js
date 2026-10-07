// 用量统计：从 Anthropic 响应（SSE message_start/message_delta 或非流式 JSON）
// 中提取 usage，按天累计并持久化到 ~/.cc-proxy/usage.json。
// 容错策略：文件缺失/损坏回退空统计，绝不抛出；路径可注入（测试）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const EMPTY_USAGE = Object.freeze({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
});

export function defaultUsagePath() {
    return path.join(os.homedir(), '.cc-proxy', 'usage.json');
}

const NUM_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
// Anthropic API 用 snake_case，落盘统计用 camelCase。
const API_FIELD_MAP = {
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    cacheReadTokens: 'cache_read_input_tokens',
    cacheCreationTokens: 'cache_creation_input_tokens'
};

// 从 message.usage（Anthropic 格式，snake_case）提取计数字段，
// 缺失/非数字字段按 0 计；usage 对象存在即视为有效（全 0 也是真实用量）。
export function extractUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    for (const field of NUM_FIELDS) {
        const value = usage[API_FIELD_MAP[field]];
        if (Number.isInteger(value) && value > 0) out[field] = value;
    }
    return out;
}

// 从单个响应（SSE 事件数组或非流式 message JSON）提取 usage：
// message_delta 的 usage 覆盖 message_start 的（最终输出计数以后到者为准）。
export function extractUsageFromResponseEvents(events) {
    // 非数组入参直接返回 null，绝不抛出（与 suggestion-mode 的容错风格一致）。
    if (!Array.isArray(events)) return null;
    let result = null;
    for (const event of events) {
        if (event?.type === 'message_start' && event.message?.usage) {
            const u = extractUsage(event.message.usage);
            if (u) result = u;
        }
        if (event?.type === 'message_delta' && event.usage) {
            const u = extractUsage(event.usage);
            // message_delta 的 usage 只带 output_tokens：仅覆盖 output 字段，
            // input/cache 沿用 message_start 的值。
            if (u) {
                result = result
                    ? { ...result, outputTokens: u.outputTokens }
                    : u;
            }
        }
    }
    return result;
}

// 按本地自然日累计（用户直觉上的"今天"），而非 UTC 日界。
function dayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// 读取持久化统计：{ 'YYYY-MM-DD': EMPTY_USAGE 形状 }；损坏回退 {}。
function readUsageFile(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return raw && typeof raw === 'object' ? raw : {};
    } catch {
        return {};
    }
}

function normalizeDay(raw) {
    const day = { ...EMPTY_USAGE };
    if (!raw || typeof raw !== 'object') return day;
    day.requests = Number.isInteger(raw.requests) && raw.requests > 0 ? raw.requests : 0;
    for (const field of NUM_FIELDS) {
        day[field] = Number.isInteger(raw[field]) && raw[field] > 0 ? raw[field] : 0;
    }
    return day;
}

export function createUsageTracker({ usageFile = defaultUsagePath(), now = () => new Date() } = {}) {
    let dirty = false;

    const record = (usage) => {
        if (!usage) return;
        const key = dayKey(now());
        const all = readUsageFile(usageFile);
        const day = normalizeDay(all[key]);
        day.requests += 1;
        // 逐字段整数校验：非法值按 0 计，避免 NaN 污染导致落盘 null 抹掉历史累计。
        for (const field of NUM_FIELDS) {
            const v = usage[field];
            if (Number.isInteger(v) && v > 0) day[field] += v;
        }
        all[key] = day;
        try {
            fs.mkdirSync(path.dirname(usageFile), { recursive: true });
            fs.writeFileSync(usageFile, JSON.stringify(all, null, 2) + '\n');
            dirty = true;
        } catch {
            // 落盘失败不阻塞代理流量。
        }
    };

    const summary = () => {
        const all = readUsageFile(usageFile);
        const key = dayKey(now());
        return { day: key, ...normalizeDay(all[key]), persisted: dirty };
    };

    return { record, summary };
}
