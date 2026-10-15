// 模型定价与费用估算：内置默认价表（每百万 token 美元）+ config
// models.<model>.pricing 覆盖 + 前缀匹配（如 claude-sonnet-5 命中
// claude-sonnet-5-2026xxxx 日期后缀）。未收录模型 estimateCost 返回 null。
import { readConfig } from './settings.js';

// 内置默认价表（USD / 每百万 token）。日期后缀变体靠前缀匹配命中。
export const DEFAULT_PRICING = Object.freeze({
    'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
    'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 }
});

// config 覆盖 → 默认价表之上叠加（精确键优先，其次前缀最长命中）。
function resolvePricing(model, configPricing) {
    if (!model || typeof model !== 'string') return null;
    if (configPricing && typeof configPricing === 'object'
        && configPricing[model]) {
        return configPricing[model];
    }
    if (configPricing && typeof configPricing === 'object') {
        let best = null;
        for (const key of Object.keys(configPricing)) {
            if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
        }
        if (best) return configPricing[best];
    }
    if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model];
    let best = null;
    for (const key of Object.keys(DEFAULT_PRICING)) {
        if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
    }
    return best ? DEFAULT_PRICING[best] : null;
}

// 估算单日费用（USD）。定价缺失任一维度或模型未收录时返回 null。
export function estimateCost(day, model, envDir) {
    if (!day || typeof day !== 'object' || !model) return null;
    const pricing = resolvePricing(model, readConfig(envDir).models);
    if (!pricing) return null;
    const usage = {
        input: day.inputTokens ?? 0,
        output: day.outputTokens ?? 0,
        cacheRead: day.cacheReadTokens ?? 0,
        cacheCreation: day.cacheCreationTokens ?? 0
    };
    let cost = 0;
    for (const key of Object.keys(usage)) {
        const price = pricing[key];
        if (typeof price !== 'number' || !Number.isFinite(price)) return null;
        cost += (usage[key] / 1e6) * price;
    }
    return cost;
}

// 当日缓存命中率：cacheRead / (cacheRead + cacheCreation + input)。
// 分母为 0（无请求）返回 null，展示层按 n/a 处理。
export function cacheHitRate(day) {
    if (!day || typeof day !== 'object') return null;
    const denom = (day.cacheReadTokens ?? 0) + (day.cacheCreationTokens ?? 0) + (day.inputTokens ?? 0);
    if (denom === 0) return null;
    return (day.cacheReadTokens ?? 0) / denom;
}

// 分级用量告警：比值 = max(今日 tokens / dailyTokens, 今日费用 / dailyCost)，
// 仅计算已配置的预算项（> 0），均未配置时 level 恒为 'none'。
// thresholds: { warnThreshold, limitThreshold }（来自 config.usageAlert，已归一化）。
// 返回 { level: 'none'|'warn'|'limit', exceeded: level==='limit', ratio }；
// ratio 为已配置项中的最大比值（无预算配置时为 0）。
export function computeUsageAlert({
    dailyTokens,
    dailyCost,
    todayTokens,
    todayCost,
    thresholds
}) {
    const warn = thresholds?.warnThreshold ?? 0.8;
    const limit = thresholds?.limitThreshold ?? 1.0;
    let ratio = 0;
    if (dailyTokens > 0 && Number.isFinite(todayTokens)) {
        ratio = Math.max(ratio, todayTokens / dailyTokens);
    }
    if (dailyCost > 0 && todayCost !== null && Number.isFinite(todayCost)) {
        ratio = Math.max(ratio, todayCost / dailyCost);
    }
    let level = 'none';
    if (ratio >= limit) level = 'limit';
    else if (ratio >= warn) level = 'warn';
    return { level, exceeded: level === 'limit', ratio };
}
