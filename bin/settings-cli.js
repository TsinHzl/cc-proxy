// 交互式设置页 CLI 壳：把终端 keystroke 流装配为行指令 async iterable，
// 交给纯逻辑 runSettingsMenu；零依赖。
import readline from 'node:readline';
import { readConfig, writeConfig, defaultConfigPath } from '../src/settings.js';

// 逐字段写回：开关切换只改 enabled；行数调整只改 lines。
export async function runSettingsCli({ envDir } = {}) {
    const dir = envDir ?? process.env.CC_PROXY_CONFIG_DIR;
    const lines = readline.createInterface({ input: process.stdin, output: process.stdout });
    const config = await runSettingsMenu({
        read: () => readConfig(dir),
        write: (partial) => writeConfig(partial, dir),
        configPath: defaultConfigPath(),
        input: lines,
        output: process.stdout
    });
    lines.close();
    return config;
}

function render(config, configPath) {
    const tw = config.thinkingWindow;
    return [
        '',
        'cc-proxy 设置',
        '=============================',
        `配置文件: ${configPath}`,
        '',
        `1) 思考滚动窗口: ${tw.enabled ? '已开启' : '已关闭'} (实验特性)`,
        `2) 窗口行数:     ${tw.lines}`,
        '',
        '输入数字并回车选择; q 退出'
    ].join('\n') + '\n';
}

function renderLinesPrompt(config) {
    return `新行数 (1-100, 当前 ${config.thinkingWindow.lines}): `;
}

// 菜单主循环。deps: { read, write, configPath, input, output }
// input 为 async iterable（逐条产出选择指令）；用显式 iterator.next() 拉取，
// 因为 for await + break 会关闭 async generator，后续输入行将全部丢失。
// 交互式终端场景由 runSettingsCli 用 readline 将 keystroke 流转换为行指令。
export async function runSettingsMenu(deps) {
    let config = deps.read();
    const iterator = deps.input[Symbol.asyncIterator]();
    const nextLine = async () => {
        const { value, done } = await iterator.next();
        return done ? '' : String(value).trim();
    };

    for (;;) {
        deps.output.write(render(config, deps.configPath));
        const choice = await nextLine();
        if (choice === 'q' || choice === 'Q' || choice === '') break;

        if (choice === '1') {
            config = deps.write({
                thinkingWindow: { ...config.thinkingWindow, enabled: !config.thinkingWindow.enabled }
            });
        } else if (choice === '2') {
            deps.output.write(renderLinesPrompt(config));
            const raw = await nextLine();
            const lines = Number(raw);
            if (Number.isInteger(lines) && lines >= 1 && lines <= 100) {
                config = deps.write({
                    thinkingWindow: { ...config.thinkingWindow, lines }
                });
            } else {
                deps.output.write(`✗ 无效行数 "${raw}"，请输入 1-100 的整数\n`);
            }
        } else {
            deps.output.write(`✗ 无效选项 "${choice}"\n`);
        }
    }

    deps.output.write(`已退出。修改已保存，下次启动 cc-proxy 生效。\n`);
    return config;
}
