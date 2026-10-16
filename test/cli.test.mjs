import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, main } from '../bin/claude-proxy.js';
import { createUsageTracker } from '../src/usage.js';
import { importJsonHistory } from '../src/usage-store.js';

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

test('normal startup injects both persisted proxy settings', async () => {
    let proxyOptions = null;
    let spawnOptions = null;
    const server = new EventEmitter();
    server.listen = (_port, host, callback) => {
        assert.equal(host, '127.0.0.1');
        callback();
    };
    server.address = () => ({ port: 4321 });
    server.close = () => {};

    await main({
        argv: ['node', BIN],
        readSettings: () => ({
            forwardSuggestionMode: true,
            thinkingAsText: false,
            effortOverride: { enabled: true, level: 'medium' },
            alerts: { dailyTokens: 0 }
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

test('startup banner warns when today usage exceeds alerts.dailyTokens', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-usage-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageFile = path.join(dir, 'usage.json');

    const tracker = createUsageTracker({ usageFile });
    tracker.record({
        input_tokens: 600,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
    });

    const warnings = [];
    const server = new EventEmitter();
    server.listen = (_port, _host, callback) => callback();
    server.address = () => ({ port: 4321 });
    server.close = () => {};

    await main({
        argv: ['node', BIN],
        readSettings: () => ({ alerts: { dailyTokens: 500 } }),
        createTracker: (opts) => createUsageTracker({ usageFile, ...opts }),
        importHistory: async () => ({ ok: true, imported: 0 }),
        createProxy: () => server,
        spawnProcess: () => new EventEmitter(),
        warn: (msg) => warnings.push(msg)
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /600 tokens.*exceeds alerts\.dailyTokens \(500\)/);
});

test('no warning when usage under threshold or alerts unconfigured', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-usage-ok-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageFile = path.join(dir, 'usage.json');

    const tracker = createUsageTracker({ usageFile });
    tracker.record({
        input_tokens: 100,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
    });

    const server = new EventEmitter();
    server.listen = (_port, _host, callback) => callback();
    server.address = () => ({ port: 4321 });
    server.close = () => {};

    for (const alerts of [{ dailyTokens: 500 }, { dailyTokens: 0 }]) {
        const warnings = [];
        main({
            argv: ['node', BIN],
            readSettings: () => ({ alerts }),
            createTracker: (opts) => createUsageTracker({ usageFile, ...opts }),
            importHistory: async () => ({ ok: true, imported: 0 }),
            createProxy: () => server,
            spawnProcess: () => new EventEmitter(),
            warn: (msg) => warnings.push(msg)
        });
        assert.equal(warnings.length, 0, `alerts=${JSON.stringify(alerts)}`);
    }
});

test('exit summary includes cache-hit rate, n/a when no denominator', async (t) => {
    // exit 总结计算被 logger.enabled 守门；测试开启 CC_PROXY_LOG 以触发输出。
    process.env.CC_PROXY_LOG = '1';
    t.after(() => { delete process.env.CC_PROXY_LOG; });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-exit-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageFile = path.join(dir, 'usage.json');

    const warnings = [];
    const server = new EventEmitter();
    server.listen = (_port, _host, callback) => callback();
    server.address = () => ({ port: 4321 });
    server.close = () => {};

    let child;
    await main({
        argv: ['node', BIN],
        readSettings: () => ({ alerts: { dailyTokens: 0 } }),
        createTracker: (opts) => createUsageTracker({ usageFile, ...opts }),
        importHistory: async () => ({ ok: true, imported: 0 }),
        createProxy: () => server,
        spawnProcess: () => {
            child = new EventEmitter();
            return child;
        },
        warn: (msg) => warnings.push(msg)
    });

    // 无任何请求：分母为 0，命中率显示 n/a。
    child.emit('exit', 0, null);
    assert.match(warnings.join('\n'), /cache-hit n\/a/);

    // 记录带缓存的请求后：命中率可计算。
    const tracker = createUsageTracker({ usageFile });
    tracker.record({
        input_tokens: 100,
        output_tokens: 0,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 0
    });
    warnings.length = 0;
    child.emit('exit', 0, null);
    assert.match(warnings.join('\n'), /cache-hit 75\.0%/);
});
