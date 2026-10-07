import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDebugLog, isDebugEnabled } from '../src/debug-log.js';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-dbg-'));
}

const fakeReq = {
    method: 'POST',
    url: '/v1/messages?beta=true',
    headers: { 'authorization': 'sk-secret', 'user-agent': 'claude-cli/2.1' }
};

test('isDebugEnabled: only CC_PROXY_DEBUG=1 enables', () => {
    assert.equal(isDebugEnabled({}), false);
    assert.equal(isDebugEnabled({ CC_PROXY_DEBUG: '1' }), true);
    assert.equal(isDebugEnabled({ CC_PROXY_DEBUG: 'true' }), false);
});

test('disabled debug log: methods are null, no files created', () => {
    const dir = tmpDir();
    const dbg = createDebugLog({ dir, enabled: false });
    assert.deepEqual(dbg, { requestStart: null, recordEvent: null, requestEnd: null });
    assert.equal(fs.readdirSync(dir).length, 0);
});

test('enabled: writes request meta, body, events, status in one file', async () => {
    const dir = tmpDir();
    const dbg = createDebugLog({ dir, enabled: true, now: () => new Date('2026-10-07T00:00:00Z') });
    const stream = dbg.requestStart(fakeReq, Buffer.from('{"model":"claude"}'));
    assert.ok(stream);
    dbg.recordEvent(stream, { type: 'message_start' });
    dbg.recordEvent(stream, { type: 'message_stop' });
    dbg.requestEnd(stream, 200, new Date('2026-10-07T00:00:00Z'));
    await new Promise((r) => stream.on('finish', r));

    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /0001-POST/);
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(text, /# 2026-10-07.*POST \/v1\/messages\?beta=true/);
    assert.match(text, /> authorization/);          // header 名称保留
    assert.doesNotMatch(text, /sk-secret/);          // header 值脱敏
    assert.match(text, /# request body \(18 bytes\)/);
    assert.match(text, /< \{"type":"message_start"\}/);
    assert.match(text, /# status=200 duration=0ms/);
});

test('enabled: write failures are silent (no throw on recordEvent with null stream)', () => {
    const dbg = createDebugLog({ dir: tmpDir(), enabled: true });
    assert.doesNotThrow(() => {
        dbg.recordEvent(null, { type: 'ping' });
        dbg.requestEnd(null, 200, new Date());
    });
});
