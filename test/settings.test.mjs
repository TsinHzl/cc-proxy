import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, defaultConfigPath, readConfig, writeConfig } from '../src/settings.js';

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-settings-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('readConfig: missing file returns defaults, no file created', (t) => {
    const dir = tmpDir(t);
    assert.deepEqual(readConfig(dir), { thinkingWindow: { enabled: false, lines: 10 } });
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('readConfig: malformed JSON falls back to defaults', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), '{not json');
    assert.deepEqual(readConfig(dir), { thinkingWindow: { enabled: false, lines: 10 } });
});

test('readConfig: invalid lines values fall back to 10', (t) => {
    const dir = tmpDir(t);
    for (const lines of [0, -5, 3.5, '20', 101]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingWindow: { lines } }));
        assert.equal(readConfig(dir).thinkingWindow.lines, 10, `lines=${JSON.stringify(lines)}`);
    }
});

test('readConfig: boundary lines 1 and 100 accepted', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingWindow: { lines: 1 } }));
    assert.equal(readConfig(dir).thinkingWindow.lines, 1);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingWindow: { lines: 100 } }));
    assert.equal(readConfig(dir).thinkingWindow.lines, 100);
});

test('readConfig: non-boolean enabled falls back to false', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingWindow: { enabled: 'yes' } }));
    assert.equal(readConfig(dir).thinkingWindow.enabled, false);
});

test('readConfig: non-object JSON (array/number) falls back to defaults', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), '[1,2]');
    assert.deepEqual(readConfig(dir), { thinkingWindow: { enabled: false, lines: 10 } });
});

// ---------- 写入与合并 ----------

test('writeConfig: creates dir and file, merged result returned', (t) => {
    const dir = tmpDir(t);
    const out = writeConfig({ thinkingWindow: { enabled: true, lines: 25 } }, dir);
    assert.equal(out.thinkingWindow.enabled, true);
    assert.equal(out.thinkingWindow.lines, 25);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), out);
});

test('writeConfig: partial merge keeps other field', (t) => {
    const dir = tmpDir(t);
    writeConfig({ thinkingWindow: { enabled: true, lines: 5 } }, dir);
    const out = writeConfig({ thinkingWindow: { lines: 7 } }, dir);
    // 逐字段合并：只改 lines 时 enabled 保留原值 true。
    assert.equal(out.thinkingWindow.lines, 7);
    assert.equal(out.thinkingWindow.enabled, true);
});

test('defaultConfigPath: points at ~/.cc-proxy/config.json', () => {
    assert.equal(defaultConfigPath(), path.join(os.homedir(), '.cc-proxy', 'config.json'));
});

test('DEFAULT_CONFIG is frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
});
