// 上游健康统计（被动）：记录各上游请求成功/失败次数、TTFT 样本（限最近 500）
// 与最近 20 条故障转移事件；快照防抖落盘 ~/.cc-proxy/runtime/upstream-health.json
// （500ms 合并写、tmp+rename 原子替换、mode 0600），settings-web 进程只读该文件。
// 统计与埋点均为同步内存操作（无 IO），绝不阻塞转发链路，也绝不向上游发探活请求。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const MAX_TTFT_SAMPLES = 500;
const MAX_FAILOVER_EVENTS = 20;
const FLUSH_DEBOUNCE_MS = 500;

// 快照文件路径：envDir 可注入（测试用临时目录），默认 ~/.cc-proxy/runtime。
export function defaultHealthPath(envDir) {
    return path.join(envDir || path.join(os.homedir(), '.cc-proxy'), 'runtime', 'upstream-health.json');
}

// 最近邻插值分位数（与 latency.js 同一算法）：升序后取 ceil(p*n)-1 位。
function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function createUpstreamHealthTracker({
    file = defaultHealthPath(),
    debounceMs = FLUSH_DEBOUNCE_MS,
    breaker = null,
    now = () => new Date()
} = {}) {
    // id → { requests, failures, ttfts: [] }；id 用上游 host（官方 API 为
    // api.anthropic.com），由 proxy.js 埋点侧提供。
    const upstreams = new Map();
    const failovers = []; // 环形：{ time, from, to, reason }
    let flushTimer = null;

    const entryOf = (id) => {
        let entry = upstreams.get(id);
        if (!entry) {
            entry = { requests: 0, failures: 0, ttfts: [] };
            upstreams.set(id, entry);
        }
        return entry;
    };

    // 请求完成埋点：ok=是否收到有效上游响应；ttftMs 仅成功路径有效（失败传 null）。
    const recordRequest = (upstreamId, { ok, ttftMs = null } = {}) => {
        if (typeof upstreamId !== 'string' || !upstreamId) return;
        const entry = entryOf(upstreamId);
        entry.requests += 1;
        if (!ok) {
            entry.failures += 1;
            scheduleFlush();
            return;
        }
        if (Number.isFinite(ttftMs) && ttftMs >= 0) {
            entry.ttfts.push(ttftMs);
            if (entry.ttfts.length > MAX_TTFT_SAMPLES) entry.ttfts.shift();
        }
        scheduleFlush();
    };

    // 失败埋点：ok=false 时可指定是否补计分母。
    // - 请求已被 recordRequest 计数（流中失败）：countRequest=false（默认），
    //   仅累加 failures，避免 requests 分母重复计数。
    // - 连接级失败（从未收到响应头，recordRequest 未被调用）：countRequest=true，
    //   补计 requests，否则成功率可能为负（failures > requests）。
    const recordFailure = (upstreamId, { countRequest = false } = {}) => {
        if (typeof upstreamId !== 'string' || !upstreamId) return;
        const entry = entryOf(upstreamId);
        if (countRequest) entry.requests += 1;
        entry.failures += 1;
        scheduleFlush();
    };

    // 故障转移埋点：环形保留最近 MAX_FAILOVER_EVENTS 条。
    const recordFailover = (from, to, reason) => {
        if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return;
        failovers.push({
            time: now().toISOString(),
            from,
            to,
            reason: typeof reason === 'string' && reason ? reason : 'unknown'
        });
        if (failovers.length > MAX_FAILOVER_EVENTS) failovers.shift();
        scheduleFlush();
    };

    // 快照：纯对象结构，settings-web 只读落盘文件，进程退出 flush 同一结构。
    const getHealthSnapshot = () => {
        // breaker 快照取一次（内部遍历全部条目），避免 map 回调内逐条重复计算。
        const breakerSnap = breaker?.getSnapshot() ?? null;
        return {
            updatedAt: now().toISOString(),
            upstreams: [...upstreams.entries()].map(([id, e]) => ({
                id,
                requests: e.requests,
                failures: e.failures,
                ttftP50: percentile(e.ttfts, 0.5),
                ttftP95: percentile(e.ttfts, 0.95),
                samples: e.ttfts.length,
                breaker: breakerSnap?.[id] ?? { ...CLOSED_BREAKER }
            })),
            failovers: [...failovers]
        };
    };

    // 原子落盘：同目录临时文件（mode 0600）+ rename 替换；失败静默（纯观测数据，
    // 不阻塞代理流量），与 usage 落盘容错策略一致。
    const flushNow = () => {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
            fs.writeFileSync(tempFile, JSON.stringify(getHealthSnapshot(), null, 2) + '\n',
                { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            try {
                fs.renameSync(tempFile, file);
            } catch (renameErr) {
                // rename 失败时清理 tmp，防止 runtime 目录积累垃圾文件。
                try { fs.unlinkSync(tempFile); } catch { /* 忽略 */ }
                throw renameErr;
            }
        } catch {
            // 落盘失败不阻塞代理流量。
        }
    };

    // 防抖合并写：埋点高频时只排一个定时器；unref 防止定时器阻止进程退出。
    const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushNow();
        }, debounceMs);
        flushTimer.unref?.();
    };

    return { recordRequest, recordFailure, recordFailover, getHealthSnapshot, flushNow };
}

// 读落盘快照（settings-web 用）：缺失/损坏/结构非法 → 空快照，绝不抛出。
// breaker 字段缺失或非法（旧版本快照、部分条目缺字段）→ 按 closed 容错补齐。
export function readHealthSnapshot(file = defaultHealthPath()) {
    const empty = { updatedAt: null, upstreams: [], failovers: [] };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
        const upstreams = Array.isArray(raw.upstreams)
            ? raw.upstreams.filter((u) => u && typeof u === 'object' && !Array.isArray(u)
                && typeof u.id === 'string' && u.id)
                .map((u) => ({
                    ...u,
                    breaker: normalizeBreakerField(u.breaker)
                }))
            : [];
        const failovers = Array.isArray(raw.failovers)
            ? raw.failovers.filter((f) => f && typeof f === 'object' && !Array.isArray(f))
            : [];
        return { updatedAt: raw.updatedAt ?? null, upstreams, failovers };
    } catch {
        return empty;
    }
}

const CLOSED_BREAKER = Object.freeze({ state: 'closed', consecutiveFailures: 0, cooldownRemainingMs: 0 });

function normalizeBreakerField(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (value.state !== 'closed' && value.state !== 'open' && value.state !== 'half-open')) {
        return { ...CLOSED_BREAKER };
    }
    return {
        state: value.state,
        consecutiveFailures: Number.isFinite(value.consecutiveFailures) && value.consecutiveFailures >= 0
            ? value.consecutiveFailures : 0,
        cooldownRemainingMs: Number.isFinite(value.cooldownRemainingMs) && value.cooldownRemainingMs >= 0
            ? value.cooldownRemainingMs : 0
    };
}
