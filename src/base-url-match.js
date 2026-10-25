// 定向匹配原语：base URL 规范化与命中判定。供两个定向特性共用——
// usage 展示缩放（usageScale）与 Effort 覆写（effortOverride），
// 保证两处匹配语义不可能分歧。
//
// 两种使用形态：
// 1) Set 形态（usageScale）：buildBaseUrlTargetSet + isBaseUrlTargetHit，
//    只关心「是否命中」。
// 2) 条目形态（effortOverride）：buildBaseUrlTargetEntries +
//    resolveBaseUrlTargetValue，命中后还要取该条目自带的值（档位）。
// 两者共用同一单条判定 matchesBaseUrlTarget，故命中语义必然一致。

// 规范化为 "protocol//hostname:port/path"（端口归一到显式值：http→80、
// https→443；路径去尾斜杠，空路径归一为 ''）。非法输入（非字符串、不可
// 解析、非 http/https 协议）返回 null。
export function normalizeBaseUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    // 去除全部尾斜杠（含 "//" 等重复尾斜杠），保证与段前缀比较口径一致。
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.hostname}:${port}${path}`;
}

// origin = 第一个 "//" 之后的第一个 "/" 之前的部分；无路径时 slice 兜底
// -1 → 整串（indexOf 命中 protocol 内 "//" 后，不会再有更早的 "/"）。
function originOf(normalized) {
    const idx = normalized.indexOf('/', normalized.indexOf('//') + 2);
    return normalized.slice(0, idx === -1 ? normalized.length : idx);
}

// 规范化串的路径部分（origin 之后，无路径为 ''）。
function pathOf(normalized) {
    return normalized.slice(originOf(normalized).length);
}

// 单条命中判定：origin（含归一端口）相等 + 配置路径为 base 路径的段前缀
// （配置路径为空覆盖该 origin 全部路径；"/api" 命中 "/api" 与 "/api/x"，
// 不命中 "/apiv2"）。Set 形态与条目形态共用此判定，命中语义不可能分歧。
export function matchesBaseUrlTarget(normalizedBase, normalizedTarget) {
    const baseOrigin = originOf(normalizedBase);
    if (baseOrigin !== originOf(normalizedTarget)) return false;
    const targetPath = pathOf(normalizedTarget);
    if (targetPath === '') return true;
    const basePath = normalizedBase.slice(baseOrigin.length);
    return basePath === targetPath || basePath.startsWith(`${targetPath}/`);
}

// 构造目标集合：规范化成功的项入 Set；输入空数组 / 全非法 → null
// （null 表示「未配置列表 = 全量生效」语义，调用方据此短路）。
export function buildBaseUrlTargetSet(baseUrls) {
    if (!Array.isArray(baseUrls)) return null;
    const set = new Set();
    for (const raw of baseUrls) {
        const normalized = normalizeBaseUrl(raw);
        if (normalized !== null) set.add(normalized);
    }
    return set.size > 0 ? set : null;
}

// 命中判定（Set 形态）：遍历集合，任一命中即为命中。
export function isBaseUrlTargetHit(normalizedBase, targetSet) {
    if (typeof normalizedBase !== 'string' || !targetSet) return false;
    for (const target of targetSet) {
        if (matchesBaseUrlTarget(normalizedBase, target)) return true;
    }
    return false;
}

// 构造条目列表：入参 [{ url, value }]，逐项规范化后
// - 去重：同规范串只保留首次出现的条目（含尾斜杠归一后的重复，以及字符串
//   与对象形态指向同一 URL 的重复）——否则「路径长度相同」时排序稳定性会
//   成为隐式的取值胜出规则；
// - 排序：按规范路径长度降序，使「最长前缀优先」由数据结构保证，调用方
//   无需二次排序（同长度保持出现顺序，Array.sort 稳定）；
// - value 归一：`undefined` 统一为 `null`，保证 resolve 的三态契约不含糊。
// 无合法项 → null（与 buildBaseUrlTargetSet 同语义：未配置列表 = 全量生效）。
export function buildBaseUrlTargetEntries(entries) {
    if (!Array.isArray(entries)) return null;
    const seen = new Set();
    const list = [];
    for (const entry of entries) {
        const base = normalizeBaseUrl(entry?.url);
        if (base === null || seen.has(base)) continue;
        seen.add(base);
        list.push({ base, value: entry.value ?? null });
    }
    if (!list.length) return null;
    return list.sort((a, b) => pathOf(b.base).length - pathOf(a.base).length);
}

// 取首个命中条目的 value，三态语义：
//   undefined —— 未命中任何条目（调用方保留基准行为，不做覆写）
//   null      —— 命中条目但该条目未指定值（调用方回退全局默认值）
//   <值>      —— 命中条目且指定了值（调用方按该值覆写）
// 三态必须可区分：调用方据此决定「按条目值覆写 / 回退全局值 / 完全不覆写」。
export function resolveBaseUrlTargetValue(normalizedBase, targetEntries) {
    if (typeof normalizedBase !== 'string' || !targetEntries) return undefined;
    for (const entry of targetEntries) {
        if (matchesBaseUrlTarget(normalizedBase, entry.base)) return entry.value;
    }
    return undefined;
}