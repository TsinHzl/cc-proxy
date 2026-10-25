// 定向匹配原语：base URL 规范化与命中判定。供两个定向特性共用——
// usage 展示缩放（usageScale）与 Effort 覆写（effortOverride），
// 保证两处匹配语义不可能分歧。

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

// 命中判定：origin（含归一端口）相等 + 路径为段前缀（配置路径为空覆盖
// 该 origin 全部路径；"/api" 命中 "/api" 与 "/api/x"，不命中 "/apiv2"）。
export function isBaseUrlTargetHit(normalizedBase, targetSet) {
    if (typeof normalizedBase !== 'string' || !targetSet) return false;
    // origin = 第一个 "//" 之后的第一个 "/" 之前的部分；无路径时 slice 兜底
    // -1 → 整串（indexOf 命中 protocol 内 "//" 后，不会再有更早的 "/"）。
    const originOf = (s) => {
        const idx = s.indexOf('/', s.indexOf('//') + 2);
        return s.slice(0, idx === -1 ? s.length : idx);
    };
    const baseOrigin = originOf(normalizedBase);
    for (const target of targetSet) {
        const targetOrigin = originOf(target);
        if (targetOrigin !== baseOrigin) continue;
        const targetPath = target.slice(targetOrigin.length);
        if (targetPath === '') return true;
        const basePath = normalizedBase.slice(baseOrigin.length);
        if (basePath === targetPath
            || basePath.startsWith(`${targetPath}/`)) return true;
    }
    return false;
}