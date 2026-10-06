import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// logger 的 enabled 标志在模块加载时固化，子进程内验证两种模式。
function runLoggerProbe(env) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { logger } from ${JSON.stringify(path.join(repoRoot, 'src/logger.js'))};
        logger.warn('warn-line');
        logger.error('error-line');
    `], {
        encoding: 'utf8',
        env: { ...process.env, ...env }
    });
}

test('logger: silent by default — no stderr output without CC_PROXY_LOG', () => {
    const r = runLoggerProbe({ CC_PROXY_LOG: '' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'stderr empty by default');
    assert.equal(r.stdout, '');
});

test('logger: CC_PROXY_LOG=1 — warn+error forwarded to stderr', () => {
    const r = runLoggerProbe({ CC_PROXY_LOG: '1' });
    assert.equal(r.status, 0);
    assert.ok(r.stderr.includes('warn-line'));
    assert.ok(r.stderr.includes('error-line'));
    assert.equal(r.stdout, '');
});
