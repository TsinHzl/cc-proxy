// 交互式设置页 CLI 壳：把终端按键流（↑↓/回车/Esc/数字）装配为指令 async
// iterable，交给纯逻辑 runSettingsMenu；非 TTY（管道冒烟）时按行解析为指令。
// 零依赖。
import readline from 'node:readline';
import { readConfig, writeConfig, defaultConfigPath } from '../src/settings.js';

// TTY：raw mode 逐键捕获；非 TTY：逐行解析（'up'/'down'/'enter'/'esc' 关键字，
// 其余行按数字逐字符拆为按键）。
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
                if (key.name === 'up') return push({ key: 'up' });
                if (key.name === 'down') return push({ key: 'down' });
                if (key.name === 'return' || key.name === 'enter') return push({ key: 'enter' });
                if (key.name === 'escape') return push({ key: 'esc' });
                if (key.ctrl && key.name === 'c') return push({ key: 'esc' });
            }
            if (str && /[0-9qQ]/.test(str)) push({ key: str });
        });
    } else {
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
            const t = line.trim();
            if (['up', 'down', 'enter', 'esc', 'q'].includes(t)) return push({ key: t });
            for (const ch of t) if (/[0-9]/.test(ch)) push({ key: ch });
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

function menuText(config, configPath, selected) {
    const tw = config.thinkingWindow;
    return [
        '',
        'cc-proxy 设置',
        '=============================',
        `配置文件: ${configPath}`,
        '',
        `${selected === 1 ? '❯' : ' '} 1) 思考滚动窗口: ${tw.enabled ? '已开启' : '已关闭'} (实验特性)`,
        `${selected === 2 ? '❯' : ' '} 2) 窗口行数:     ${tw.lines}`,
        '',
        '↑↓ 选择，回车确认，Esc 退出'
    ].join('\n') + '\n';
}

const countLines = (text) => text.split('\n').length - 1;

// 菜单主循环。deps: { read, write, configPath, input, output }
// input 为指令 async iterable：{ key: 'up'|'down'|'enter'|'esc'|'q'|数字字符 }。
// 交互流程：↑↓ 选择 → 回车执行 → 显示「设置成功」→ 自动退出整个设置页；
// 选 2 后逐位输入行数（空回车 = 默认 10；非法数字提示后重输；Esc 返回菜单）。
export async function runSettingsMenu(deps) {
    let config = deps.read();
    let selected = 1;
    let mode = 'menu'; // 'menu' | 'lines'
    let buffer = '';
    let cursorRow = 0; // 光标当前行相对菜单首行的偏移（1-based）

    const write = (s) => deps.output.write(s);
    const renderMenu = () => {
        const text = menuText(config, deps.configPath, selected);
        cursorRow = countLines(text);
        write(text);
    };
    const redrawMenu = () => {
        // menuText 以 '\n' 结尾，渲染后光标在菜单下方一行的行尾（raw mode 下
        // '\r' 先归零列）：上移 cursorRow 行回到菜单首行（含首行空行）再整页擦除。
        write(`\r\x1b[${cursorRow}A\x1b[J`);
        renderMenu();
    };
    const renderLinesPrompt = () => {
        write(`\n新行数 (1-100, 回车 = 默认 10, Esc 返回): ${buffer}`);
        cursorRow += 1;
    };

    // 首帧只画一次；此后仅 redrawMenu / lines 返回路径按需重绘，
    // 否则每次按键后循环顶部会再叠一份完整菜单。
    renderMenu();

    for (;;) {
        const { value, done } = await deps.input[Symbol.asyncIterator]().next();
        const key = done ? 'eof' : value.key;

        if (mode === 'menu') {
            if (key === 'up' || key === 'down') {
                selected = selected === 1 ? 2 : 1;
                redrawMenu();
            } else if (key === 'enter') {
                if (selected === 1) {
                    config = deps.write({
                        thinkingWindow: { ...config.thinkingWindow, enabled: !config.thinkingWindow.enabled }
                    });
                    write(`\n✓ 设置成功：思考滚动窗口已${config.thinkingWindow.enabled ? '开启' : '关闭'}，下次启动 cc-proxy 生效。\n`);
                    return config;
                }
                mode = 'lines';
                buffer = '';
                renderLinesPrompt();
            } else if (key === 'esc' || key === 'q' || key === 'Q' || key === 'eof') {
                write('\n已退出，未做修改。\n');
                return config;
            }
            // 菜单态数字键忽略
        } else if (mode === 'lines') {
            if (key === 'eof') {
                // 非 TTY 输入流提前耗尽：直接退出，避免 next() 永久挂起。
                write('\n已退出，未保存。\n');
                return config;
            }
            if (key === 'esc') {
                // 清掉输入提示行，回到菜单重绘（上移 cursorRow 行回到菜单首行）
                write('\r\x1b[2K');
                write(`\r\x1b[${cursorRow}A\x1b[J`);
                mode = 'menu';
                buffer = '';
                renderMenu();
            } else if (key === 'enter') {
                const lines = buffer === '' ? 10 : Number(buffer);
                if (Number.isInteger(lines) && lines >= 1 && lines <= 100) {
                    config = deps.write({
                        thinkingWindow: { ...config.thinkingWindow, lines }
                    });
                    write('\n');
                    write(`✓ 设置成功：窗口行数 = ${lines}，下次启动 cc-proxy 生效。\n`);
                    return config;
                }
                write('\r\x1b[2K');
                buffer = '';
                write(`✗ 无效行数，请输入 1-100 的整数（回车 = 默认 10, Esc 返回）: ${buffer}`);
            } else if (/^[0-9]$/.test(key)) {
                if (buffer.length < 3) buffer += key;
                write('\r\x1b[2K');
                write(`新行数 (1-100, 回车 = 默认 10, Esc 返回): ${buffer}`);
            }
            // 其他键忽略
        }
    }
}
