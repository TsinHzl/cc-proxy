import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    assert.deepEqual(config, { thinkingWindow: { enabled: false, lines: 10 }, forwardSuggestionMode: false, thinkingAsText: true, effortOverride: { enabled: true, level: 'high' } });
    assert.match(output, /配置文件: .*config\.json/);
    assert.match(output, /已退出/);
});

test('settings menu: enter also exits without changes', async (t) => {
    const dir = tmpDir(t);
    const { config } = await driveMenu(t, dir, ['enter']);
    assert.deepEqual(config, { thinkingWindow: { enabled: false, lines: 10 }, forwardSuggestionMode: false, thinkingAsText: true, effortOverride: { enabled: true, level: 'high' } });
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'no config written');
});

test('settings menu: key 1 toggles forwardSuggestionMode, confirms state, and exits', async (t) => {
    const dir = tmpDir(t);
    // 1 → 切到开并提示后自动退出；落盘为开启态。
    const { config, output } = await driveMenu(t, dir, ['1']);
    assert.equal(config.forwardSuggestionMode, true);
    assert.match(output, /设置已保存：Suggestion Mode 输入建议转发 → 开/);
    assert.match(output, /已退出/);
    assert.equal(readConfig(dir).forwardSuggestionMode, true);
});

test('settings menu: key 1 toggles off state confirmation when starting from on', async (t) => {
    const dir = tmpDir(t);
    writeConfig({ forwardSuggestionMode: true }, dir);
    const { config, output } = await driveMenu(t, dir, ['1']);
    assert.equal(config.forwardSuggestionMode, false);
    assert.match(output, /设置已保存：Suggestion Mode 输入建议转发 → 关/);
    assert.equal(readConfig(dir).forwardSuggestionMode, false);
});
