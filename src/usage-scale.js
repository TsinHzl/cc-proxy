// 客户端可见 usage 缩放：按用户配置比例改写返回给 Claude Code 的 token
// 计数（input 类字段），控制 Ctx% 显示与 auto-compact 触发时机。
// 仅作用于客户端可见响应；内部统计（usage.json）始终记录上游真实值。
// 关闭（enabled=false）时本模块不被调用（proxy 侧零开销路径）。

// 参与缩放的 input 类字段：output_tokens 不缩放（避免影响客户端
// max_tokens 计算）。cache_creation 嵌套字段在存在时才改写。
const SCALED_TOP_LEVEL_FIELDS = [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens'
];
const SCALED_CACHE_CREATION_FIELDS = [
    'ephemeral_5m_input_tokens',
    'ephemeral_1h_input_tokens'
];

function scaleValue(value, ratio) {
    if (!Number.isInteger(value) || value <= 0) return value;
    return Math.ceil(value * ratio);
}

// 对 usage 对象做浅拷贝并缩放 input 类字段（不可变更新，不改原对象）。
// ratio=1 时直接返回原引用（零改写，避免无谓拷贝）。
// 非正整数字段保持原样；usage 非对象时返回 null。
export function scaleUsageForClient(usage, ratio) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
    if (ratio === 1) return usage;
    let changed = false;
    const out = { ...usage };
    for (const field of SCALED_TOP_LEVEL_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(usage, field)) continue;
        const scaled = scaleValue(usage[field], ratio);
        if (scaled !== usage[field]) {
            out[field] = scaled;
            changed = true;
        }
    }
    const cacheCreation = usage.cache_creation;
    if (cacheCreation && typeof cacheCreation === 'object'
        && !Array.isArray(cacheCreation)) {
        let nestedChanged = false;
        const nested = { ...cacheCreation };
        for (const field of SCALED_CACHE_CREATION_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(cacheCreation, field)) continue;
            const scaled = scaleValue(cacheCreation[field], ratio);
            if (scaled !== cacheCreation[field]) {
                nested[field] = scaled;
                nestedChanged = true;
            }
        }
        if (nestedChanged) {
            out.cache_creation = nested;
            changed = true;
        }
    }
    return changed ? out : usage;
}

// 对 SSE 事件（message_start / message_delta）返回改写 usage 后的新事件
// 对象，其他事件类型原样返回（无 usage 或非目标事件零拷贝）。
// scaleUsageForClient 对畸形 usage（非对象）返回 null：视同透传返回原
// 事件，绝不把畸形数据改写为 null（透传语义优先）。
export function scaleUsageInEvent(event, ratio) {
    if (ratio === 1) return event;
    if (!event || typeof event !== 'object') return event;
    if (event.type === 'message_start' && event.message?.usage) {
        const usage = scaleUsageForClient(event.message.usage, ratio);
        if (!usage || usage === event.message.usage) return event;
        return { ...event, message: { ...event.message, usage } };
    }
    if (event.type === 'message_delta' && event.usage) {
        const usage = scaleUsageForClient(event.usage, ratio);
        if (!usage || usage === event.usage) return event;
        return { ...event, usage };
    }
    return event;
}

// 对非流式 message JSON 返回改写 usage 后的新对象；非 message 或无
// usage 时原样返回（error 等其他 JSON 类型不触碰；畸形 usage 同样透传）。
export function scaleUsageInMessageJson(parsed, ratio) {
    if (ratio === 1) return parsed;
    if (!parsed || typeof parsed !== 'object') return parsed;
    if (parsed.type !== 'message' || !parsed.usage) return parsed;
    const usage = scaleUsageForClient(parsed.usage, ratio);
    if (!usage || usage === parsed.usage) return parsed;
    return { ...parsed, usage };
}
