// 持久化配置：~/.cc-proxy/config.json（路径可注入，测试用临时目录）。
// 容错策略：文件缺失/损坏/字段非法一律回退默认值，绝不抛出。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
    thinkingWindow: { enabled: false, lines: 10 },
    // Suggestion Mode 放行开关：false（默认）拦截 CC 输入建议请求并返回空响应，
    // true 时正常转发上游（展示输入建议，产生额外计费）。
    forwardSuggestionMode: false,
    // 默认保持现有 thinking → text 展示；false 时恢复 CC 原生 thinking 块。
    thinkingAsText: true,
    // Effort 覆写：开启时统一将 CC 请求体中的 effort 档位改写为 level，
    // 无论 CC 本地设置是什么。默认开启且为 high。
    effortOverride: { enabled: true, level: 'high' },
    // 系统提示词覆写：开启且 prompt 非空时统一将 CC 请求体的 system 字段
    // 替换为配置文本。默认关闭；prompt 为空时覆写按 no-op 处理。
    systemPromptOverride: { enabled: false, prompt: '' },
    // 用量展示缩放：开启后按 ratio 缩放返回客户端的 usage input 类字段
    // （output 不缩放），控制 Ctx% 显示与 auto-compact 触发时机。默认关闭
    // （上游是多少就是多少）；ratio 有限数 (0, 10]，非法回退 1.0。
    // baseUrls 为定向列表（默认 [] = 全量缩放）：非空时仅命中完整 base
    // URL 的上游缩放，未命中 1:1 透传。
    usageScale: { enabled: false, ratio: 1.0, baseUrls: [] },
    // 用量告警阈值：当日 tokens 超过 dailyTokens 时 CLI 启动提示 + 设置页红点。
    // 0 表示未配置（不告警）。dailyCost 为费用预算（美元，> 0 有效，0 = 未配置）。
    alerts: { dailyTokens: 0, dailyCost: 0 },
    // 分级告警阈值（比值语义）：warnThreshold（预警，默认 0.8）/ limitThreshold
    // （超限，默认 1.0）。校验 0 < warn < limit ≤ 1，非法整体回退默认。
    usageAlert: { warnThreshold: 0.8, limitThreshold: 1.0 },
    // 模型定价覆盖（每百万 token 美元）：models.<model>.pricing =
    // { input, output, cacheRead, cacheCreation }，未收录模型不显示费用。
    models: {},
    // 备用上游数组（多上游故障转移）：每项 { name, baseUrl, headers? }，
    // 主上游重试耗尽后依次切换；空数组表示未配置（单上游，行为与现状一致）。
    upstreams: []
});

const MIN_LINES = 1;
const MAX_LINES = 100;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
// 自定义系统提示词上限：与 thinking-text.js 的 MAX_THINKING_TEXT_BLOCK_BYTES 对齐。
const MAX_PROMPT_BYTES = 256 * 1024;

// 供 settings-cli 显示与 e2e 断言的默认落盘路径。
export function defaultConfigPath() {
    return path.join(os.homedir(), '.cc-proxy', 'config.json');
}

// 行数非法（非整数、<1 或 >100）回退默认 10；enabled / forwardSuggestionMode
// 非布尔回退 false（默认拦截建议请求）；effortOverride.enabled 非布尔回退 true，
// level 非枚举回退 'high'（出厂默认语义，方向与 thinkingWindow 相反）；
// systemPromptOverride.enabled 非布尔回退 false，prompt 非字符串或超 256KB 回退 ''。
function normalizeConfig(raw) {
    const config = {
        thinkingWindow: { ...DEFAULT_CONFIG.thinkingWindow },
        forwardSuggestionMode: DEFAULT_CONFIG.forwardSuggestionMode,
        thinkingAsText: DEFAULT_CONFIG.thinkingAsText,
        effortOverride: { ...DEFAULT_CONFIG.effortOverride },
        systemPromptOverride: { ...DEFAULT_CONFIG.systemPromptOverride },
        usageScale: { ...DEFAULT_CONFIG.usageScale },
        alerts: { ...DEFAULT_CONFIG.alerts },
        usageAlert: { ...DEFAULT_CONFIG.usageAlert },
        models: {},
        upstreams: []
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return config;
    const tw = raw.thinkingWindow;
    if (tw && typeof tw === 'object' && !Array.isArray(tw)) {
        if (typeof tw.enabled === 'boolean') config.thinkingWindow.enabled = tw.enabled;
        if (Number.isInteger(tw.lines) && tw.lines >= MIN_LINES && tw.lines <= MAX_LINES) {
            config.thinkingWindow.lines = tw.lines;
        }
    }
    const eo = raw.effortOverride;
    if (eo && typeof eo === 'object' && !Array.isArray(eo)) {
        if (typeof eo.enabled === 'boolean') config.effortOverride.enabled = eo.enabled;
        if (EFFORT_LEVELS.has(eo.level)) config.effortOverride.level = eo.level;
    }
    const spo = raw.systemPromptOverride;
    if (spo && typeof spo === 'object' && !Array.isArray(spo)) {
        if (typeof spo.enabled === 'boolean') config.systemPromptOverride.enabled = spo.enabled;
        if (typeof spo.prompt === 'string'
            && Buffer.byteLength(spo.prompt, 'utf8') <= MAX_PROMPT_BYTES) {
            config.systemPromptOverride.prompt = spo.prompt;
        }
    }
    const us = raw.usageScale;
    if (us && typeof us === 'object' && !Array.isArray(us)) {
        if (typeof us.enabled === 'boolean') config.usageScale.enabled = us.enabled;
        if (typeof us.ratio === 'number' && Number.isFinite(us.ratio)
            && us.ratio > 0 && us.ratio <= 10) {
            config.usageScale.ratio = us.ratio;
        }
        // 定向列表：逐项校验（字符串 + new URL 可解析 + http/https 协议），
        // 非法项逐项丢弃（与 upstreams 风格一致），不整体回退。
        if (Array.isArray(us.baseUrls)) {
            const cleanBaseUrls = [];
            for (const entry of us.baseUrls) {
                if (typeof entry !== 'string') continue;
                const value = entry.trim();
                if (!value) continue;
                try {
                    const u = new URL(value);
                    if (u.protocol === 'http:' || u.protocol === 'https:') {
                        cleanBaseUrls.push(value);
                    }
                } catch {
                    // 非法 URL 项逐项丢弃。
                }
            }
            config.usageScale.baseUrls = cleanBaseUrls;
        }
    }
    if (typeof raw.forwardSuggestionMode === 'boolean') {
        config.forwardSuggestionMode = raw.forwardSuggestionMode;
    }
    if (typeof raw.thinkingAsText === 'boolean') {
        config.thinkingAsText = raw.thinkingAsText;
    }
    const alerts = raw.alerts;
    if (alerts && typeof alerts === 'object' && !Array.isArray(alerts)) {
        // 非负整数才接受（0 = 未配置告警；tokens 计数本身为整数，小数视为非法），
        // 并加上界 1e12 防御异常超大值导致展示溢出。
        if (Number.isSafeInteger(alerts.dailyTokens) && alerts.dailyTokens >= 0
            && alerts.dailyTokens <= 1e12) {
            config.alerts.dailyTokens = alerts.dailyTokens;
        }
        // 费用预算：正有限数接受，其余（含 0/负数/非数值）回退 0（未配置）。
        if (typeof alerts.dailyCost === 'number' && Number.isFinite(alerts.dailyCost)
            && alerts.dailyCost > 0) {
            config.alerts.dailyCost = alerts.dailyCost;
        }
    }
    const usageAlert = raw.usageAlert;
    if (usageAlert && typeof usageAlert === 'object' && !Array.isArray(usageAlert)) {
        // 比值语义：0 < warn < limit ≤ 1，任一非法或关系不满足则整体回退默认。
        const warn = usageAlert.warnThreshold;
        const limit = usageAlert.limitThreshold;
        if (Number.isFinite(warn) && Number.isFinite(limit)
            && warn > 0 && limit > 0 && warn < limit && limit <= 1) {
            config.usageAlert = { warnThreshold: warn, limitThreshold: limit };
        }
    }
    const models = raw.models;
    if (models && typeof models === 'object' && !Array.isArray(models)) {
        // null 原型容器：模型名来自用户配置字符串，防 "__proto__" 等危险键。
        const pricingByModel = Object.create(null);
        for (const [model, entry] of Object.entries(models)) {
            if (typeof model !== 'string' || !model) continue;
            const pricing = entry?.pricing ?? entry;
            if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) continue;
            const clean = {};
            for (const key of ['input', 'output', 'cacheRead', 'cacheCreation']) {
                const v = pricing[key];
                if (typeof v === 'number' && Number.isFinite(v) && v >= 0) clean[key] = v;
            }
            // 至少一项合法定价才收录该模型条目。
            if (Object.keys(clean).length > 0) pricingByModel[model] = clean;
        }
        if (Object.keys(pricingByModel).length > 0) {
            config.models = pricingByModel;
        }
    }
    const upstreams = raw.upstreams;
    if (Array.isArray(upstreams)) {
        const cleanUpstreams = [];
        for (const item of upstreams) {
            // 每项须为非数组对象且 baseUrl 为可解析的合法 URL，非法项整项丢弃
            // （非法 baseUrl 会让代理启动时 resolveUpstream 抛错崩溃）。
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            if (typeof item.baseUrl !== 'string' || !item.baseUrl) continue;
            let host;
            try {
                host = new URL(item.baseUrl).host;
            } catch {
                continue;
            }
            const name = (typeof item.name === 'string' && item.name) ? item.name : host;
            const clean = { name, baseUrl: item.baseUrl };
            // headers 须为字符串键值对象，非法时仅丢弃该字段，不丢整项。
            if (item.headers !== undefined) {
                const headers = item.headers;
                if (headers && typeof headers === 'object' && !Array.isArray(headers)
                    && Object.values(headers).every((v) => typeof v === 'string')) {
                    clean.headers = { ...headers };
                }
            }
            cleanUpstreams.push(clean);
        }
        config.upstreams = cleanUpstreams;
    }
    return config;
}

// envDir 可选：覆盖配置目录（CC_PROXY_CONFIG_DIR 场景），默认 ~/.cc-proxy。
export function readConfig(envDir) {
    const file = path.join(envDir || path.join(os.homedir(), '.cc-proxy'), 'config.json');
    try {
        return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
        return normalizeConfig(null);
    }
}

// 浅合并 partial 到当前配置后写回；thinkingWindow / effortOverride 为逐字段
// 合并，顶层键（forwardSuggestionMode 等）仅在 partial 提供合法值时更新，
// 未提供保留原值。
// 顶层键必须参与合并，否则会在下一次 thinkingWindow 写盘时被静默丢弃。
export function writeConfig(partial, envDir) {
    const dir = envDir || path.join(os.homedir(), '.cc-proxy');
    const file = path.join(dir, 'config.json');
    const current = readConfig(dir);
    const merged = normalizeConfig({
        thinkingWindow: { ...current.thinkingWindow, ...partial?.thinkingWindow },
        effortOverride: { ...current.effortOverride, ...partial?.effortOverride },
        systemPromptOverride: {
            ...current.systemPromptOverride,
            ...partial?.systemPromptOverride
        },
        usageScale:
            partial?.usageScale && typeof partial.usageScale === 'object'
                && !Array.isArray(partial.usageScale)
                ? { ...current.usageScale, ...partial.usageScale }
                : current.usageScale,
        forwardSuggestionMode:
            typeof partial?.forwardSuggestionMode === 'boolean'
                ? partial.forwardSuggestionMode
                : current.forwardSuggestionMode,
        thinkingAsText:
            typeof partial?.thinkingAsText === 'boolean'
                ? partial.thinkingAsText
                : current.thinkingAsText,
        alerts:
            partial?.alerts && typeof partial.alerts === 'object' && !Array.isArray(partial.alerts)
                ? { ...current.alerts, ...partial.alerts }
                : current.alerts,
        usageAlert:
            partial?.usageAlert && typeof partial.usageAlert === 'object'
                && !Array.isArray(partial.usageAlert)
                ? { ...current.usageAlert, ...partial.usageAlert }
                : current.usageAlert,
        models:
            partial?.models && typeof partial.models === 'object' && !Array.isArray(partial.models)
                ? { ...current.models, ...partial.models }
                : current.models,
        upstreams: Array.isArray(partial?.upstreams) ? partial.upstreams : current.upstreams
    });
    fs.mkdirSync(dir, { recursive: true });
    let mode = 0o600;
    try {
        mode = fs.statSync(file).mode & 0o777;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const tempFile = path.join(dir, `.config.json.${process.pid}.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(tempFile, JSON.stringify(merged, null, 2) + '\n', {
            encoding: 'utf8',
            flag: 'wx',
            mode
        });
        // writeFileSync 的 mode 受 umask 影响（如 0666 会被 umask 022 压成 0644），
        // rename 前显式 chmod 确保保留原配置文件权限。
        fs.chmodSync(tempFile, mode);
        fs.renameSync(tempFile, file);
    } catch (error) {
        try {
            fs.rmSync(tempFile, { force: true });
        } catch {
            // 保留原始写入或 rename 错误。
        }
        throw error;
    }
    return readConfig(dir);
}
