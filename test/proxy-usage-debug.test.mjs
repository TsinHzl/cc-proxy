import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyServer } from '../src/proxy.js';
import { createUsageTracker } from '../src/usage.js';
import { createDebugLog } from '../src/debug-log.js';

// SSE mock upstream：发完整 message_start + message_delta 序列。
function startMockUpstream(events, { json = false } = {}) {
    const server = http.createServer((req, res) => {
        if (json) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(events));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const e of events) {
            res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        }
        res.end();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function tmpFile(name) {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-p-')), name);
}

// 与实现一致的本地日界 key（dayKey 未导出，测试端复刻）。
function localDayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

test('proxy records usage from SSE stream into usage.json', async () => {
    const usageFile = tmpFile('usage.json');
    const upstream = await startMockUpstream([
        { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'message_delta', usage: { output_tokens: 42 } }
    ]);
    const tracker = createUsageTracker({ usageFile });
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        usageTracker: tracker
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.1', 'content-type': 'application/json' },
            body: '{}'
        });
        await res.text();
        assert.deepEqual(tracker.summary(), {
            day: localDayKey(),
            requests: 1,
            inputTokens: 100,
            outputTokens: 42,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            persisted: true
        });
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('proxy records usage from non-streaming message JSON', async () => {
    const usageFile = tmpFile('usage.json');
    const upstream = await startMockUpstream(
        { type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 7, output_tokens: 3 } },
        { json: true }
    );
    const tracker = createUsageTracker({ usageFile });
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        usageTracker: tracker
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.1', 'content-type': 'application/json' },
            body: '{}'
        });
        await res.json();
        const s = tracker.summary();
        assert.equal(s.requests, 1);
        assert.equal(s.inputTokens, 7);
        assert.equal(s.outputTokens, 3);
    } finally {
        proxy.close();
        upstream.close();
    }
});

test('proxy writes debug log file when enabled, nothing when disabled', async () => {
    const dir = tmpDir();
    const upstream = await startMockUpstream([
        { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }
    ]);
    const dbg = createDebugLog({ dir, enabled: true, now: () => new Date() });
    const proxy = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
        debugLog: dbg
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    try {
        await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.1', 'content-type': 'application/json' },
            body: '{"model":"claude-sonnet-5"}'
        });
        // 等写流 flush。
        await new Promise((r) => setTimeout(r, 60));
        const files = fs.readdirSync(dir);
        assert.equal(files.length, 1);
        const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
        assert.match(text, /POST \/v1\/messages/);
        assert.match(text, /message_start/);
        assert.match(text, /# status=200/);

        // 关闭态：零文件。
        const dirOff = tmpDir();
        const proxyOff = createProxyServer({
            baseUrlEnv: `http://127.0.0.1:${upstream.address().port}`,
            debugLog: createDebugLog({ dir: dirOff, enabled: false })
        });
        await new Promise((r) => proxyOff.listen(0, '127.0.0.1', r));
        await fetch(`http://127.0.0.1:${proxyOff.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'user-agent': 'claude-cli/2.1', 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(fs.readdirSync(dirOff).length, 0);
        proxyOff.close();
    } finally {
        proxy.close();
        upstream.close();
    }
});

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-p-'));
}
