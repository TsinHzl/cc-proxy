import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSettingsMenu } from '../bin/settings-cli.js';
import { readConfig, writeConfig } from '../src/settings.js';

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-settings-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// 内存 stdin/stdout 装配，驱动菜单并收集输出。inputs 为指令 key 数组。
// 输出中 ESC 控制序列替换为 <ESC>。
async function driveMenu(t, dir, keys) {
    const chunks = [];
    const input = (async function* () { for (const k of keys) yield { key: k }; })();
    const output = { write: (s) => chunks.push(s) };
    const config = await runSettingsMenu({
        read: () => readConfig(dir),
        write: (partial) => writeConfig(partial, dir),
        configPath: path.join(dir, 'config.json'),
        input,
        output
    });
    return { config, output: chunks.join('').replace(/\x1b\[\d*[A-Za-z]/g, '<ESC>') };
}

test('settings menu: shows config path and exits without changes (esc)', async (t) => {
    const dir = tmpDir(t);
    const { config, output } = await driveMenu(t, dir, ['esc']);
    assert.deepEqual(config, { thinkingWindow: { enabled: false, lines: 10 } });
    assert.match(output, /配置文件: .*config\.json/);
    assert.match(output, /已退出，未做修改/);
});

test('settings menu: enter also exits without changes', async (t) => {
    const dir = tmpDir(t);
    const { config } = await driveMenu(t, dir, ['enter']);
    assert.deepEqual(config, { thinkingWindow: { enabled: false, lines: 10 } });
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'no config written');
});

// ---------- e2e 冒烟：--setting 管道喂入 → 不触碰真实配置 ----------

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

test('e2e: cc-proxy --setting exits cleanly and writes nothing to CC_PROXY_CONFIG_DIR', async (t) => {
    const dir = tmpDir(t);
    const { code } = await runCli(['--setting'], { CC_PROXY_CONFIG_DIR: dir }, 'esc\n');
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});
