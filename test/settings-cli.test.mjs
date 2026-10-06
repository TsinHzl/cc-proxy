import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSettingsMenu } from '../bin/settings-cli.js';
import { readConfig, writeConfig as writeConfigImpl } from '../src/settings.js';

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-settings-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// 内存 stdin/stdout 装配，驱动菜单并收集输出。
async function driveMenu(t, dir, inputs) {
    const chunks = [];
    const input = (async function* () { for (const i of inputs) yield `${i}\n`; })();
    const output = { write: (s) => chunks.push(s) };
    const config = await runSettingsMenu({
        read: () => readConfig(dir),
        write: (partial) => writeConfig(partial, dir),
        configPath: path.join(dir, 'config.json'),
        input,
        output
    });
    return { config, output: chunks.join('') };
}

function writeConfig(partial, dir) {
    return writeConfigImpl(partial, dir);
}

test('settings menu: toggle switch persists enabled=true', async (t) => {
    const dir = tmpDir(t);
    const { config, output } = await driveMenu(t, dir, ['1', 'q']);
    assert.equal(config.thinkingWindow.enabled, true);
    assert.equal(readConfig(dir).thinkingWindow.enabled, true);
    assert.match(output, /思考滚动窗口: 已开启/);
});

test('settings menu: adjust lines persists value', async (t) => {
    const dir = tmpDir(t);
    const { config } = await driveMenu(t, dir, ['2', '25', 'q']);
    assert.equal(config.thinkingWindow.lines, 25);
    assert.equal(readConfig(dir).thinkingWindow.lines, 25);
});

test('settings menu: invalid lines rejected and retried', async (t) => {
    const dir = tmpDir(t);
    const { config, output } = await driveMenu(t, dir, ['2', '500', '2', '30', 'q']);
    assert.equal(config.thinkingWindow.lines, 30);
    assert.match(output, /无效行数 "500"/);
});

test('settings menu: invalid choice reported, state unchanged', async (t) => {
    const dir = tmpDir(t);
    const { config, output } = await driveMenu(t, dir, ['9', 'q']);
    assert.deepEqual(config, { thinkingWindow: { enabled: false, lines: 10 } });
    assert.match(output, /无效选项 "9"/);
});

// ---------- e2e 冒烟：--setting 管道喂入 → CC_PROXY_CONFIG_DIR 落盘 ----------

function repoRoot() {
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function runCli(args, env, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(repoRoot(), 'bin/claude-proxy.js'), ...args], {
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        child.stdin.write(input);
        child.stdin.end();
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, out }));
    });
}

test('e2e: cc-proxy --setting toggles window on via CC_PROXY_CONFIG_DIR', async (t) => {
    const dir = tmpDir(t);
    const { code } = await runCli(['--setting'], { CC_PROXY_CONFIG_DIR: dir }, '1\nq\n');
    assert.equal(code, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.thinkingWindow.enabled, true);
    // 真实配置目录未被触碰（若存在则应保持原值——此处仅断言临时目录语义）
    assert.equal(readConfig(dir).thinkingWindow.enabled, true);
});
