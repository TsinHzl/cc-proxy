// 交互式设置页 CLI 壳：把终端按键流（回车/Esc/q）装配为指令 async iterable，
// 交给纯逻辑 runSettingsMenu；非 TTY（管道冒烟）时按行解析为指令。零依赖。
import readline from 'node:readline';
import { readConfig, defaultConfigPath } from '../src/settings.js';

// TTY：raw mode 逐键捕获；非 TTY：逐行解析（'enter'/'esc' 关键字，
// 其余非空行按回车处理）。
function createInput() {
    const queue = [];
    let notify = null;
    const push = (ev) => {
        queue.push(ev);
        if (notify) { const n = notify; notify = null; n(); }
    };

    if (process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.on('keypress', (str, key) => {
            if (key) {
                if (key.name === 'return' || key.name === 'enter') return push({ key: 'enter' });
                if (key.name === 'escape') return push({ key: 'esc' });
                if (key.ctrl && key.name === 'c') return push({ key: 'esc' });
            }
            if (str === 'q' || str === 'Q') push({ key: str });
        });
    } else {
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
            const t = line.trim();
            if (t === 'esc' || t === 'q') return push({ key: t });
            if (t) push({ key: 'enter' });
        });
        rl.on('close', () => push({ key: 'eof' }));
    }

    return {
        dispose() {
            // 恢复终端状态：退出前关 raw mode、停流、摘除监听，防止挂起。
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdin.removeAllListeners('keypress');
            }
        },
        [Symbol.asyncIterator]() {
            return {
                async next() {
                    for (;;) {
                        if (queue.length) return { value: queue.shift(), done: false };
                        await new Promise((resolve) => { notify = resolve; });
                    }
                }
            };
        }
    };
}

export async function runSettingsCli({ envDir } = {}) {
    const dir = envDir ?? process.env.CC_PROXY_CONFIG_DIR;
    const input = createInput();
    try {
        return await runSettingsMenu({
            read: () => readConfig(dir),
            write: (partial) => writeConfig(partial, dir),
            configPath: defaultConfigPath(),
            input,
            output: process.stdout
        });
    } finally {
        input.dispose();
    }
}

function menuText(config, configPath) {
    return [
        '',
        'cc-proxy 设置',
        '=============================',
        `配置文件: ${configPath}`,
        '',
        `当前配置: ${JSON.stringify(config)}`,
        '',
        '回车/Esc 退出'
    ].join('\n') + '\n';
}

// 菜单主循环。deps: { read, write, configPath, input, output }
// input 为指令 async iterable：{ key: 'enter'|'esc'|'q'|'eof' }。
// 展示当前配置与落盘路径；回车/Esc 退出整个设置页。
export async function runSettingsMenu(deps) {
    const config = deps.read();

    const write = (s) => deps.output.write(s);
    const renderMenu = () => {
        write(menuText(config, deps.configPath));
    };

    // 首帧只画一次；此后仅退出路径需要清屏重绘。
    renderMenu();

    for (;;) {
        const { value, done } = await deps.input[Symbol.asyncIterator]().next();
        const key = done ? 'eof' : value.key;

        if (key === 'esc' || key === 'q' || key === 'Q' || key === 'enter' || key === 'eof') {
            write('\n已退出，未做修改。\n');
            return config;
        }
        // 其他键忽略
    }
}
