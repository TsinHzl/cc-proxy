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
    effortOverride: { enabled: true, level: 'high' }
});

const MIN_LINES = 1;
const MAX_LINES = 100;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);

// 供 settings-cli 显示与 e2e 断言的默认落盘路径。
export function defaultConfigPath() {
    return path.join(os.homedir(), '.cc-proxy', 'config.json');
}

// 行数非法（非整数、<1 或 >100）回退默认 10；enabled / forwardSuggestionMode
// 非布尔回退 false（默认拦截建议请求）；effortOverride.enabled 非布尔回退 true，
// level 非枚举回退 'high'（出厂默认语义，方向与 thinkingWindow 相反）。
function normalizeConfig(raw) {
    const config = {
        thinkingWindow: { ...DEFAULT_CONFIG.thinkingWindow },
        forwardSuggestionMode: DEFAULT_CONFIG.forwardSuggestionMode,
        thinkingAsText: DEFAULT_CONFIG.thinkingAsText,
        effortOverride: { ...DEFAULT_CONFIG.effortOverride }
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
    if (typeof raw.forwardSuggestionMode === 'boolean') {
        config.forwardSuggestionMode = raw.forwardSuggestionMode;
    }
    if (typeof raw.thinkingAsText === 'boolean') {
        config.thinkingAsText = raw.thinkingAsText;
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
        forwardSuggestionMode:
            typeof partial?.forwardSuggestionMode === 'boolean'
                ? partial.forwardSuggestionMode
                : current.forwardSuggestionMode,
        thinkingAsText:
            typeof partial?.thinkingAsText === 'boolean'
                ? partial.thinkingAsText
                : current.thinkingAsText
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
