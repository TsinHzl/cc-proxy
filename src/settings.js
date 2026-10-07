// 持久化配置：~/.cc-proxy/config.json（路径可注入，测试用临时目录）。
// 容错策略：文件缺失/损坏/字段非法一律回退默认值，绝不抛出。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_CONFIG = Object.freeze({
    thinkingWindow: { enabled: false, lines: 10 },
    // Suggestion Mode 放行开关：false（默认）拦截 CC 输入建议请求并返回空响应，
    // true 时正常转发上游（展示输入建议，产生额外计费）。
    forwardSuggestionMode: false
});

const MIN_LINES = 1;
const MAX_LINES = 100;

// 供 settings-cli 显示与 e2e 断言的默认落盘路径。
export function defaultConfigPath() {
    return path.join(os.homedir(), '.cc-proxy', 'config.json');
}

// 行数非法（非整数、<1 或 >100）回退默认 10；enabled / forwardSuggestionMode
// 非布尔回退 false（默认拦截建议请求）。
function normalizeConfig(raw) {
    const config = {
        thinkingWindow: { ...DEFAULT_CONFIG.thinkingWindow },
        forwardSuggestionMode: DEFAULT_CONFIG.forwardSuggestionMode
    };
    if (!raw || typeof raw !== 'object') return config;
    const tw = raw.thinkingWindow;
    if (tw && typeof tw === 'object') {
        if (typeof tw.enabled === 'boolean') config.thinkingWindow.enabled = tw.enabled;
        if (Number.isInteger(tw.lines) && tw.lines >= MIN_LINES && tw.lines <= MAX_LINES) {
            config.thinkingWindow.lines = tw.lines;
        }
    }
    if (typeof raw.forwardSuggestionMode === 'boolean') {
        config.forwardSuggestionMode = raw.forwardSuggestionMode;
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

// 浅合并 partial 到当前配置后写回；thinkingWindow 为逐字段合并，顶层键
// （forwardSuggestionMode）仅在 partial 提供合法布尔时更新，未提供保留原值。
// 顶层键必须参与合并，否则会在下一次 thinkingWindow 写盘时被静默丢弃。
export function writeConfig(partial, envDir) {
    const dir = envDir || path.join(os.homedir(), '.cc-proxy');
    const file = path.join(dir, 'config.json');
    const current = readConfig(dir);
    const merged = {
        thinkingWindow: { ...current.thinkingWindow, ...partial?.thinkingWindow },
        forwardSuggestionMode:
            typeof partial?.forwardSuggestionMode === 'boolean'
                ? partial.forwardSuggestionMode
                : current.forwardSuggestionMode
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(normalizeConfig(merged), null, 2) + '\n');
    return readConfig(dir);
}
