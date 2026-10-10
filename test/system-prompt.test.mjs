import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    extractSystemText,
    buildOverriddenSystem,
    createSystemPromptCapture
} from '../src/system-prompt.js';

function tmpFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-sysprompt-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'captured-system-prompt.json');
}

// ---------- extractSystemText ----------

test('extractSystemText: string form returns as-is', () => {
    assert.equal(extractSystemText('You are Claude Code.'), 'You are Claude Code.');
});

test('extractSystemText: blocks form joins text blocks with blank line', () => {
    const system = [
        { type: 'text', text: 'First part.' },
        { type: 'text', text: 'Second part.' }
    ];
    assert.equal(extractSystemText(system), 'First part.\n\nSecond part.');
});

test('extractSystemText: blocks form skips non-text blocks', () => {
    const system = [
        { type: 'text', text: 'Only text.' },
        { type: 'image', source: {} },
        { type: 'text', text: 'After.' }
    ];
    assert.equal(extractSystemText(system), 'Only text.\n\nAfter.');
});

test('extractSystemText: blocks form with no text blocks returns null', () => {
    assert.equal(extractSystemText([]), null);
});

test('extractSystemText: missing/invalid forms return null', () => {
    for (const system of [undefined, null, 42, {}, [{ nope: true }]]) {
        assert.equal(extractSystemText(system), null, `system=${JSON.stringify(system)}`);
    }
});

// ---------- buildOverriddenSystem ----------

test('buildOverriddenSystem: string form replaced with prompt string', () => {
    assert.equal(buildOverriddenSystem('original', 'custom'), 'custom');
});

test('buildOverriddenSystem: blocks form becomes single text block keeping cache_control', () => {
    const current = [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'b' }
    ];
    assert.deepEqual(buildOverriddenSystem(current, 'custom'), [
        { type: 'text', text: 'custom', cache_control: { type: 'ephemeral' } }
    ]);
});

test('buildOverriddenSystem: cache_control picked from any block (trailing marker)', () => {
    // Anthropic 惯例将缓存断点标记在末块；仅取首块会静默丢失缓存。
    const current = [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }
    ];
    assert.deepEqual(buildOverriddenSystem(current, 'custom'), [
        { type: 'text', text: 'custom', cache_control: { type: 'ephemeral' } }
    ]);
});

test('buildOverriddenSystem: blocks form without cache_control produces bare text block', () => {
    assert.deepEqual(buildOverriddenSystem([{ type: 'text', text: 'a' }], 'custom'), [
        { type: 'text', text: 'custom' }
    ]);
});

test('buildOverriddenSystem: invalid current system returns null (no write)', () => {
    for (const current of [undefined, null, 42, {}]) {
        assert.equal(buildOverriddenSystem(current, 'custom'), null, `current=${JSON.stringify(current)}`);
    }
});

// ---------- createSystemPromptCapture ----------

test('createSystemPromptCapture: returns null without file path', () => {
    assert.equal(createSystemPromptCapture({}), null);
    assert.equal(createSystemPromptCapture(), null);
});

test('capture: writes extracted text on first request, mode 0600', (t) => {
    const file = tmpFile(t);
    const capture = createSystemPromptCapture({ file });

    capture.capture([
        { type: 'text', text: 'You are Claude Code.' }
    ]);

    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
        prompt: 'You are Claude Code.'
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('capture: unchanged text does not rewrite the file', (t) => {
    const file = tmpFile(t);
    const capture = createSystemPromptCapture({ file });

    capture.capture('first');
    const before = fs.statSync(file).mtimeMs;

    capture.capture('first');
    capture.capture('first');
    assert.equal(fs.statSync(file).mtimeMs, before);
});

test('capture: changed text rewrites the file', (t) => {
    const file = tmpFile(t);
    const capture = createSystemPromptCapture({ file });

    capture.capture('v1');
    capture.capture('v2');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { prompt: 'v2' });
});

test('capture: empty extracted text never writes', (t) => {
    const file = tmpFile(t);
    const capture = createSystemPromptCapture({ file });

    capture.capture('');
    capture.capture([]);
    capture.capture(null);
    capture.capture(undefined);
    assert.equal(fs.existsSync(file), false);
});

test('capture: readCaptured returns null on missing file', (t) => {
    const capture = createSystemPromptCapture({ file: tmpFile(t) });
    assert.equal(capture.readCaptured(), null);
});

test('capture: readCaptured returns null on malformed JSON', (t) => {
    const file = tmpFile(t);
    fs.writeFileSync(file, '{not json');
    const capture = createSystemPromptCapture({ file });
    assert.equal(capture.readCaptured(), null);
});

test('capture: readCaptured returns null on non-string prompt', (t) => {
    const file = tmpFile(t);
    for (const prompt of [null, 42, true, [], {}]) {
        fs.writeFileSync(file, JSON.stringify({ prompt }));
        assert.equal(createSystemPromptCapture({ file }).readCaptured(), null, `prompt=${JSON.stringify(prompt)}`);
    }
});

test('capture: corrupted file is silently replaced by next capture', (t) => {
    const file = tmpFile(t);
    fs.writeFileSync(file, '{not json');
    const capture = createSystemPromptCapture({ file });

    capture.capture('recovered');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { prompt: 'recovered' });
});

test('capture: write failure never throws', (t) => {
    const file = tmpFile(t);
    const capture = createSystemPromptCapture({ file });

    const realWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (target, data, ...args) => {
        if (String(target) === file || String(target).includes('.tmp')) {
            throw new Error('simulated write failure');
        }
        return realWriteFileSync(target, data, ...args);
    };
    t.after(() => { fs.writeFileSync = realWriteFileSync; });

    assert.doesNotThrow(() => capture.capture('blocked'));
    assert.equal(fs.existsSync(file), false);
});
