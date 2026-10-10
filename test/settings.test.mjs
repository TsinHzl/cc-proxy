import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, defaultConfigPath, readConfig, writeConfig } from '../src/settings.js';

const EXPECTED_DEFAULT_CONFIG = {
    thinkingWindow: { enabled: false, lines: 10 },
    forwardSuggestionMode: false,
    thinkingAsText: true,
    effortOverride: { enabled: true, level: 'high' }
};

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-settings-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('readConfig: missing file returns defaults, no file created', (t) => {
    const dir = tmpDir(t);
    assert.deepEqual(readConfig(dir), EXPECTED_DEFAULT_CONFIG);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('readConfig: malformed JSON falls back to defaults', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), '{not json');
    assert.deepEqual(readConfig(dir), EXPECTED_DEFAULT_CONFIG);
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
    assert.deepEqual(readConfig(dir), EXPECTED_DEFAULT_CONFIG);
});

test('readConfig: old config without thinkingAsText defaults it to true', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        thinkingWindow: { enabled: true, lines: 25 },
        forwardSuggestionMode: true
    }));
    assert.deepEqual(readConfig(dir), {
        thinkingWindow: { enabled: true, lines: 25 },
        forwardSuggestionMode: true,
        thinkingAsText: true,
        effortOverride: { enabled: true, level: 'high' }
    });
});

test('readConfig: explicit boolean false disables thinkingAsText', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingAsText: false }));
    assert.equal(readConfig(dir).thinkingAsText, false);
});

// ---------- effortOverride ----------

test('readConfig: old config without effortOverride defaults it to enabled/high', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        thinkingWindow: { enabled: true, lines: 25 },
        forwardSuggestionMode: true
    }));
    assert.deepEqual(readConfig(dir).effortOverride, { enabled: true, level: 'high' });
});

test('readConfig: explicit effortOverride values persist', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        effortOverride: { enabled: false, level: 'low' }
    }));
    assert.deepEqual(readConfig(dir).effortOverride, { enabled: false, level: 'low' });
});

test('readConfig: invalid effortOverride fields fall back field-by-field', (t) => {
    const dir = tmpDir(t);
    for (const enabled of [null, 0, 1, 'false', []]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            effortOverride: { enabled, level: 'medium' }
        }));
        assert.equal(readConfig(dir).effortOverride.enabled, true, `enabled=${JSON.stringify(enabled)}`);
    }
    for (const level of [null, 0, 'extreme', 'HIGH', [], {}]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
            effortOverride: { enabled: false, level }
        }));
        assert.equal(readConfig(dir).effortOverride.level, 'high', `level=${JSON.stringify(level)}`);
    }
});

test('readConfig: non-object effortOverride falls back to defaults', (t) => {
    const dir = tmpDir(t);
    for (const effortOverride of [null, 'high', 7, ['low']]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ effortOverride }));
        assert.deepEqual(readConfig(dir).effortOverride, { enabled: true, level: 'high' });
    }
});

test('writeConfig: effortOverride partial merge keeps sibling field', (t) => {
    const dir = tmpDir(t);
    writeConfig({ effortOverride: { enabled: false, level: 'low' } }, dir);
    const out = writeConfig({ effortOverride: { level: 'medium' } }, dir);
    // 逐字段合并：只改 level 时 enabled 保留原值 false。
    assert.equal(out.effortOverride.level, 'medium');
    assert.equal(out.effortOverride.enabled, false);
});

test('writeConfig: effortOverride write keeps other top-level settings', (t) => {
    const dir = tmpDir(t);
    writeConfig({ forwardSuggestionMode: true, thinkingAsText: false }, dir);
    const out = writeConfig({ effortOverride: { level: 'low' } }, dir);
    // 防丢失：写 effortOverride 不得重置已保存的顶层开关。
    assert.equal(out.forwardSuggestionMode, true);
    assert.equal(out.thinkingAsText, false);
    assert.deepEqual(out.effortOverride, { enabled: true, level: 'low' });
});

test('readConfig: invalid thinkingAsText values fall back to true', (t) => {
    const dir = tmpDir(t);
    for (const thinkingAsText of [null, 0, 1, 'false', [], {}]) {
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thinkingAsText }));
        assert.equal(
            readConfig(dir).thinkingAsText,
            true,
            `thinkingAsText=${JSON.stringify(thinkingAsText)}`
        );
    }
});

// ---------- 写入与合并 ----------

test('writeConfig: creates dir and file, merged result returned', (t) => {
    const dir = tmpDir(t);
    const out = writeConfig({ thinkingWindow: { enabled: true, lines: 25 } }, dir);
    assert.equal(out.thinkingWindow.enabled, true);
    assert.equal(out.thinkingWindow.lines, 25);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), out);
});

test('writeConfig: creates new config with mode 0600', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');

    writeConfig({ thinkingAsText: false }, dir);

    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeConfig: preserves existing config mode', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(EXPECTED_DEFAULT_CONFIG));
    fs.chmodSync(file, 0o640);

    writeConfig({ thinkingAsText: false }, dir);

    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.equal(readConfig(dir).thinkingAsText, false);
});

test('writeConfig: partial merge keeps other field', (t) => {
    const dir = tmpDir(t);
    writeConfig({ thinkingWindow: { enabled: true, lines: 5 } }, dir);
    const out = writeConfig({ thinkingWindow: { lines: 7 } }, dir);
    // 逐字段合并：只改 lines 时 enabled 保留原值 true。
    assert.equal(out.thinkingWindow.lines, 7);
    assert.equal(out.thinkingWindow.enabled, true);
});

test('writeConfig: forwardSuggestionMode persists, defaults to false', (t) => {
    const dir = tmpDir(t);
    assert.equal(readConfig(dir).forwardSuggestionMode, false);
    const out = writeConfig({ forwardSuggestionMode: true }, dir);
    assert.equal(out.forwardSuggestionMode, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).forwardSuggestionMode, true);
});

test('writeConfig: thinkingWindow write keeps forwardSuggestionMode (top-level merge)', (t) => {
    const dir = tmpDir(t);
    writeConfig({ forwardSuggestionMode: true }, dir);
    const out = writeConfig({ thinkingWindow: { enabled: true, lines: 3 } }, dir);
    // 防丢失：写 thinkingWindow 不得重置已保存的顶层开关。
    assert.equal(out.forwardSuggestionMode, true);
    assert.equal(out.thinkingWindow.lines, 3);
});

test('normalizeConfig: non-boolean forwardSuggestionMode falls back to false', (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ forwardSuggestionMode: 'yes' }));
    assert.equal(readConfig(dir).forwardSuggestionMode, false);
});

test('writeConfig: cross-field partial writes preserve unrelated settings', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
        thinkingWindow: { enabled: true, lines: 30 },
        forwardSuggestionMode: true,
        thinkingAsText: false,
        effortOverride: { enabled: false, level: 'low' }
    }));

    let out = writeConfig({ thinkingWindow: { lines: 40 } }, dir);
    assert.deepEqual(out, {
        thinkingWindow: { enabled: true, lines: 40 },
        forwardSuggestionMode: true,
        thinkingAsText: false,
        effortOverride: { enabled: false, level: 'low' }
    });

    out = writeConfig({ forwardSuggestionMode: false }, dir);
    assert.deepEqual(out, {
        thinkingWindow: { enabled: true, lines: 40 },
        forwardSuggestionMode: false,
        thinkingAsText: false,
        effortOverride: { enabled: false, level: 'low' }
    });

    out = writeConfig({ thinkingAsText: true }, dir);
    assert.deepEqual(out, {
        thinkingWindow: { enabled: true, lines: 40 },
        forwardSuggestionMode: false,
        thinkingAsText: true,
        effortOverride: { enabled: false, level: 'low' }
    });

    out = writeConfig({ effortOverride: { enabled: true, level: 'medium' } }, dir);
    assert.deepEqual(out, {
        thinkingWindow: { enabled: true, lines: 40 },
        forwardSuggestionMode: false,
        thinkingAsText: true,
        effortOverride: { enabled: true, level: 'medium' }
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), out);
});

test('writeConfig: temp write failure preserves original config and removes temp file', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');
    const original = '{"thinkingAsText":false}\n';
    fs.writeFileSync(file, original);

    const realWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (target, data, ...args) => {
        const targetPath = String(target);
        if (path.dirname(targetPath) === dir && targetPath !== file) {
            realWriteFileSync(targetPath, '{"partial"', ...args);
            throw new Error('simulated temp write failure');
        }
        return realWriteFileSync(target, data, ...args);
    };
    t.after(() => { fs.writeFileSync = realWriteFileSync; });

    assert.throws(() => writeConfig({ thinkingAsText: true }, dir), /simulated temp write failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('writeConfig: rename failure preserves original config and removes temp file', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'config.json');
    const original = '{"thinkingAsText":false}\n';
    fs.writeFileSync(file, original);

    const realRenameSync = fs.renameSync;
    let observedTemp;
    fs.renameSync = (source, destination) => {
        observedTemp = String(source);
        assert.equal(path.dirname(observedTemp), dir);
        assert.equal(String(destination), file);
        throw new Error('simulated rename failure');
    };
    t.after(() => { fs.renameSync = realRenameSync; });

    assert.throws(() => writeConfig({ thinkingAsText: true }, dir), /simulated rename failure/);
    assert.ok(observedTemp);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('defaultConfigPath: points at ~/.cc-proxy/config.json', () => {
    assert.equal(defaultConfigPath(), path.join(os.homedir(), '.cc-proxy', 'config.json'));
});

test('DEFAULT_CONFIG contains expected defaults and is frozen', () => {
    assert.deepEqual(DEFAULT_CONFIG, EXPECTED_DEFAULT_CONFIG);
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
});
