import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, main } from '../bin/claude-proxy.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-proxy.js');

test('claude-proxy --version prints version and exits without spawning', () => {
    const r = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^claude-proxy \d+\.\d+\.\d+\n$/);
});

test('claude-proxy -v is an alias of --version', () => {
    const r = spawnSync(process.execPath, [BIN, '-v'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^claude-proxy \d+\.\d+\.\d+\n$/);
});

test('claude-proxy --setting starts only the Web settings service', async () => {
    let settingCalls = 0;
    const result = main({
        argv: ['node', BIN, '--setting'],
        runSettings: async () => { settingCalls += 1; },
        readSettings: () => assert.fail('config snapshot should not be read'),
        createProxy: () => assert.fail('proxy should not be created'),
        spawnProcess: () => assert.fail('Claude Code should not be spawned')
    });

    await result;
    assert.equal(settingCalls, 1);
});

test('direct execution resolves symlink entry path', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const link = path.join(dir, 'cc-proxy');
    fs.symlinkSync(BIN, link);

    assert.equal(isDirectExecution({
        moduleUrl: new URL('../bin/claude-proxy.js', import.meta.url).href,
        argvPath: link
    }), true);
});

test('direct execution returns false for a different entry', () => {
    assert.equal(isDirectExecution({
        moduleUrl: new URL('../bin/claude-proxy.js', import.meta.url).href,
        argvPath: fileURLToPath(import.meta.url)
    }), false);
});

test('normal startup injects both persisted proxy settings', () => {
    let proxyOptions = null;
    let spawnOptions = null;
    const server = new EventEmitter();
    server.listen = (_port, host, callback) => {
        assert.equal(host, '127.0.0.1');
        callback();
    };
    server.address = () => ({ port: 4321 });
    server.close = () => {};

    main({
        argv: ['node', BIN],
        readSettings: () => ({
            forwardSuggestionMode: true,
            thinkingAsText: false,
            effortOverride: { enabled: true, level: 'medium' }
        }),
        createProxy: (options) => {
            proxyOptions = options;
            return server;
        },
        spawnProcess: (_command, _args, options) => {
            spawnOptions = options;
            return new EventEmitter();
        }
    });

    assert.equal(proxyOptions.forwardSuggestionMode, true);
    assert.equal(proxyOptions.thinkingAsText, false);
    assert.deepEqual(proxyOptions.effortOverride, { enabled: true, level: 'medium' });
    assert.equal(spawnOptions.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321');
});
