// 系统提示词捕获与覆写：CC 请求的 system 字段支持 string / blocks 双形态。
// 捕获是代理观测数据（落盘 captured-system-prompt.json），覆写是用户配置行为；
// 容错策略与 suggestion-mode.js 一致：payload 缺字段/类型不符一律不命中，绝不抛出。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// 提取 system 字段纯文本：string 形态原样返回；blocks 数组形态将 text 块按
// \n\n 拼接为单个字符串（CC 的 system 块间以空行分隔的可读等价物）。
// 非 string / 非数组形态（缺失、null、数字等），或数组中无任何 text 块时
// 返回 null，调用方据此跳过。
export function extractSystemText(system) {
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        const parts = [];
        for (const block of system) {
            if (block?.type === 'text' && typeof block.text === 'string') {
                parts.push(block.text);
            }
        }
        return parts.length ? parts.join('\n\n') : null;
    }
    return null;
}

// 覆写构造：原 system 为 string 时返回配置字符串本身；为 blocks 数组时返回
// 单 text 块数组，任一原块的 cache_control 原样带到新块（Anthropic 惯例将
// 缓存断点标记在末块，仅取首块会在多块形态下静默丢失缓存）。其余形态
// （缺失/非法）返回 null，调用方据此跳过覆写（不补写 system）。
export function buildOverriddenSystem(currentSystem, prompt) {
    if (typeof currentSystem === 'string') return prompt;
    if (Array.isArray(currentSystem)) {
        const hit = currentSystem.find((block) => block && typeof block === 'object'
            && 'cache_control' in block);
        const cacheControl = hit ? { cache_control: hit.cache_control } : {};
        return [{ type: 'text', text: prompt, ...cacheControl }];
    }
    return null;
}

// 捕获文件路径单点定义：与 config.json / usage.json 同目录（os.homedir()）。
export function capturedSystemPromptPath(home = os.homedir()) {
    return path.join(home, '.cc-proxy', 'captured-system-prompt.json');
}

// 捕获落盘工厂：文本变化才写盘（稳定态零写盘），上次文本由工厂闭包缓存，
// 请求热路径无读盘开销；临时文件 + rename 原子替换，mode 0600；读损坏回退
// null；全程不抛，辅助数据绝不影响代理流量。
export function createSystemPromptCapture({ file } = {}) {
    if (!file || typeof file !== 'string') return null;
    const tempFile = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
    );
    // 上次捕获文本缓存：null 表示「无捕获或与缓存一致未知」，首次比较读盘一次。
    let lastCaptured = null;
    let lastKnown = false;

    const readCaptured = () => {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return typeof parsed?.prompt === 'string' ? parsed.prompt : null;
        } catch {
            return null;
        }
    };

    const capture = (system) => {
        const text = extractSystemText(system);
        if (text === null || text === '') return;
        try {
            if (lastKnown && lastCaptured === text) return;
            if (!lastKnown) {
                lastCaptured = readCaptured();
                if (lastCaptured === text) {
                    lastKnown = true;
                    return;
                }
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(tempFile, JSON.stringify({ prompt: text }, null, 2) + '\n', {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600
            });
            fs.chmodSync(tempFile, 0o600);
            fs.renameSync(tempFile, file);
            lastCaptured = text;
            lastKnown = true;
        } catch {
            try {
                fs.rmSync(tempFile, { force: true });
            } catch {
                // 保留原始写盘错误。
            }
            // 静默降级：写盘失败不影响转发（与 debug-log 同哲学）。
        }
    };

    return { capture, readCaptured };
}
