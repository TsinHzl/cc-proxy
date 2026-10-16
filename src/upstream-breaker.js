// 上游熔断器（纯内存状态机）：每个上游独立维护 closed / open / half-open 状态。
// closed →（连续失败 ≥ failureThreshold，成功即清零）→ open（选路跳过，不发请求）
// → 冷却 cooldownMs 后 → half-open（放行 1 个探测请求）→ 成功 closed / 失败 open（重新计时）。
// 无 IO、重启即重置；快照字段由 getSnapshot() 提供，由 upstream-health tracker 合入落盘。
const STATE_CLOSED = 'closed';
const STATE_OPEN = 'open';
const STATE_HALF_OPEN = 'half-open';

export function createUpstreamBreaker({
    failureThreshold = 3,
    cooldownMs = 30000,
    now = () => Date.now()
} = {}) {
    // id → { state, consecutiveFailures, openedAt, probeInFlight }
    const breakers = new Map();

    const entryOf = (id) => {
        let entry = breakers.get(id);
        if (!entry) {
            entry = { state: STATE_CLOSED, consecutiveFailures: 0, openedAt: null, probeInFlight: false };
            breakers.set(id, entry);
        }
        return entry;
    };

    // open 且冷却已过 → 迁移到 half-open（惰性迁移，无定时器）。
    const settleIfCooldownElapsed = (entry) => {
        if (entry.state !== STATE_OPEN) return;
        if (now() - entry.openedAt >= cooldownMs) {
            entry.state = STATE_HALF_OPEN;
            entry.probeInFlight = false;
        }
    };

    const recordSuccess = (id) => {
        if (typeof id !== 'string' || !id) return;
        const entry = entryOf(id);
        entry.consecutiveFailures = 0;
        entry.probeInFlight = false;
        if (entry.state !== STATE_CLOSED) entry.state = STATE_CLOSED;
    };

    const recordFailure = (id) => {
        if (typeof id !== 'string' || !id) return;
        const entry = entryOf(id);
        entry.probeInFlight = false;
        if (entry.state === STATE_HALF_OPEN) {
            // 探测失败：重新熔断并重新计时。
            entry.state = STATE_OPEN;
            entry.openedAt = now();
            return;
        }
        entry.consecutiveFailures += 1;
        if (entry.consecutiveFailures >= failureThreshold && entry.state === STATE_CLOSED) {
            entry.state = STATE_OPEN;
            entry.openedAt = now();
        }
    };

    // 选路前询问：返回 { allowed, isProbe }。
    // - 冷却已过且无并发探测占用 → { allowed: true, isProbe: true }（进入 half-open，本请求即探测）
    // - 并发第二个请求 / 冷却未过 → { allowed: false, isProbe: false }（走备用）
    const probe = (id) => {
        if (typeof id !== 'string' || !id) return { allowed: false, isProbe: false };
        const entry = entryOf(id);
        if (entry.state === STATE_CLOSED) return { allowed: true, isProbe: false };
        settleIfCooldownElapsed(entry);
        if (entry.state === STATE_OPEN) return { allowed: false, isProbe: false };
        // half-open：同时最多 1 个探测请求。
        if (entry.probeInFlight) return { allowed: false, isProbe: false };
        entry.probeInFlight = true;
        return { allowed: true, isProbe: true };
    };

    const isOpen = (id) => {
        const entry = breakers.get(id);
        if (!entry) return false;
        settleIfCooldownElapsed(entry);
        return entry.state === STATE_OPEN;
    };

    const getState = (id) => {
        const entry = breakers.get(id);
        if (!entry) return STATE_CLOSED;
        settleIfCooldownElapsed(entry);
        return entry.state;
    };

    // 快照字段：由 tracker 合入 upstream-health.json（只写不读回，重启即重置）。
    const getSnapshot = () => {
        const out = {};
        for (const [id, entry] of breakers) {
            settleIfCooldownElapsed(entry);
            out[id] = {
                state: entry.state,
                consecutiveFailures: entry.consecutiveFailures,
                cooldownRemainingMs: entry.state === STATE_OPEN
                    ? Math.max(0, cooldownMs - (now() - entry.openedAt))
                    : 0
            };
        }
        return out;
    };

    return { recordSuccess, recordFailure, probe, isOpen, getState, getSnapshot };
}
