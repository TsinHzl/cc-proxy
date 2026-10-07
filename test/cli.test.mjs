import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
