import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { forwardRequestWithRetry } from '../src/upstream.js';
import { createProxyServer } from '../src/proxy.js';

// Mock upstream：handler 自定义响应行为；记录调用次数与最近一次请求头。
function startMockUpstream(handler) {
    let calls = 0;
    let lastHeaders = null;
    let lastBody = null;
    const server = http.createServer((req, res) => {
        calls += 1;
        lastHeaders = req.headers;
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            lastBody = Buffer.concat(chunks).toString('utf8');
            handler(req, res);
        });
    });
    server.calls = () => calls;
    server.lastHeaders = () => lastHeaders;
    server.lastBody = () => lastBody;
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function sse(res, body = 'ok') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
}

function target(port) {
    return { protocol: 'http:', host: '127.0.0.1', port: String(port), path: '/v1/messages' };
}

function send(targets, options = {}, body = Buffer.from('{}')) {
    return new Promise((resolve, reject) => {
        // forwardRequestWithRetry 只读取 req.headers / req.method，用最小桩即可。
        const req = { headers: { 'content-type': 'application/json' }, method: 'POST' };
        forwardRequestWithRetry(req, body, targets, (upstreamRes) => {
            const chunks = [];
            upstreamRes.on('data', (c) => chunks.push(c));
            upstreamRes.on('end', () => resolve({ status: upstreamRes.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }, reject, options);
    });
}

test('fails over to backup after primary exhausts 503 retries', async () => {
    let failoverEvents = null;
    let failoverEntry = null;
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('overloaded');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'from-backup'));
    try {
        const res = await send([target(primary.address().port), target(backup.address().port)], {
            onFailover: (from, to, reason, toEntry) => {
                failoverEvents = [from, to];
                failoverEntry = toEntry;
            }
        });
        assert.equal(res.status, 200);
        assert.equal(res.body, 'from-backup');
        assert.equal(primary.calls(), 4); // 首次 + 3 次同上游重试
        assert.equal(backup.calls(), 1);
        assert.deepEqual(failoverEvents, ['127.0.0.1', '127.0.0.1']);
        // 第 4 参数：切换目标 entry（裸 target 经 toEntry 包装），携带完整
        // target 供定向缩放等需要完整 base URL 的消费方使用。
        assert.equal(failoverEntry.target.port, String(backup.address().port));
    } finally {
        primary.close();
        backup.close();
    }
});

test('onFailover 4th arg carries the backup entry with caller-attached fields', async () => {
    let failoverEntry = null;
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('err');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'ok'));
    const backupEntry = {
        target: target(backup.address().port),
        name: 'backup',
        base: 'http://127.0.0.1:9999/api'
    };
    try {
        await send([target(primary.address().port), backupEntry], {
            onFailover: (from, to, reason, toEntry) => { failoverEntry = toEntry; }
        });
        // 包装对象原样透传（含调用方附加的 base 字段），供 proxy 定向缩放判定。
        assert.equal(failoverEntry, backupEntry);
        assert.equal(failoverEntry.base, 'http://127.0.0.1:9999/api');
        assert.equal(failoverEntry.name, 'backup');
    } finally {
        primary.close();
        backup.close();
    }
});

test('per-entry body: each upstream sends its own body, fallback to original', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('err');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'ok'));
    const original = '{"effort":"local"}';
    const overridden = '{"effort":"high"}';
    try {
        // entry.body 存在时该上游使用它；缺省时回退原始请求体。
        await send([
            { target: target(primary.address().port), body: Buffer.from(overridden) },
            { target: target(backup.address().port) }
        ], {}, Buffer.from(original));
        assert.equal(primary.lastBody(), overridden);
        assert.equal(backup.lastBody(), original);
    } finally {
        primary.close();
        backup.close();
    }
});

test('429 and 500 trigger failover immediately without same-upstream retry', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('rate-limited');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'ok-backup'));
    try {
        const res = await send([target(primary.address().port), target(backup.address().port)]);
        assert.equal(res.status, 200);
        assert.equal(primary.calls(), 1); // 不做同上游重试，直接切换
        assert.equal(backup.calls(), 1);
    } finally {
        primary.close();
        backup.close();
    }
});

test('merges per-upstream headers into the failover request', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('err');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'ok'));
    try {
        await send([
            target(primary.address().port),
            { target: target(backup.address().port), headers: { 'x-api-key': 'backup-key', 'x-custom': 'v1' } }
        ]);
        const seen = backup.lastHeaders();
        assert.equal(seen['x-api-key'], 'backup-key');
        assert.equal(seen['x-custom'], 'v1');
        assert.equal(seen['content-type'], 'application/json'); // 原请求头保留
    } finally {
        primary.close();
        backup.close();
    }
});

test('all upstreams exhausted returns the last error response', async () => {
    const makeErr = (body) => async (req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(body);
    };
    const first = await startMockUpstream(makeErr('first-err'));
    const second = await startMockUpstream(makeErr('second-err'));
    try {
        const res = await send([target(first.address().port), target(second.address().port)]);
        assert.equal(res.status, 503);
        assert.equal(res.body, 'second-err');
        assert.equal(first.calls(), 4);
        assert.equal(second.calls(), 4);
    } finally {
        first.close();
        second.close();
    }
});

test('bare target entry (no wrapper) still works in a multi-target list', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end('bad-gateway');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'ok'));
    try {
        const res = await send([target(primary.address().port), target(backup.address().port)]);
        assert.equal(res.status, 200);
        assert.equal(res.body, 'ok');
    } finally {
        primary.close();
        backup.close();
    }
});

test('connection-level failure on primary fails over to backup', async () => {
    const placeholder = http.createServer();
    await new Promise((r) => placeholder.listen(0, '127.0.0.1', r));
    const deadPort = placeholder.address().port;
    await new Promise((r) => placeholder.close(r));

    const backup = await startMockUpstream((req, res) => sse(res, 'after-dead'));
    try {
        const res = await send([target(deadPort), target(backup.address().port)]);
        assert.equal(res.status, 200);
        assert.equal(res.body, 'after-dead');
        assert.equal(backup.calls(), 1);
    } finally {
        backup.close();
    }
});

test('single upstream keeps existing retry semantics (4 attempts, last 503)', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('still-down');
    });
    try {
        const res = await send([target(primary.address().port)]);
        assert.equal(res.status, 503);
        assert.equal(res.body, 'still-down');
        assert.equal(primary.calls(), 4);
    } finally {
        primary.close();
    }
});

test('proxy integration: failoverUpstreams are resolved and used on primary failure', async () => {
    const primary = await startMockUpstream((req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('primary-err');
    });
    const backup = await startMockUpstream((req, res) => sse(res, 'proxy-failover-ok'));
    const server = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${primary.address().port}`,
        failoverUpstreams: [{ name: 'backup', baseUrl: `http://127.0.0.1:${backup.address().port}`, headers: { 'x-api-key': 'bk' } }]
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
            body: '{}'
        });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), 'proxy-failover-ok');
        assert.equal(primary.calls(), 1);
        assert.equal(backup.calls(), 1);
        assert.equal(backup.lastHeaders()['x-api-key'], 'bk');
    } finally {
        server.close();
        primary.close();
        backup.close();
    }
});

test('invalid target entries (null / malformed) are skipped, request reaches valid backup', async () => {
    const backup = await startMockUpstream((req, res) => sse(res, 'from-valid-backup'));
    try {
        // 畸形条目被 toEntry 归为 null 并过滤，不抛错也不阻塞转发。
        const res = await send([
            null,
            'not-an-object',
            { target: { noHost: true } },
            target(backup.address().port)
        ]);
        assert.equal(res.status, 200);
        assert.equal(res.body, 'from-valid-backup');
        assert.equal(backup.calls(), 1);
    } finally {
        backup.close();
    }
});

test('proxy integration: no failoverUpstreams configured — request goes to primary only', async () => {
    const primary = await startMockUpstream((req, res) => sse(res, 'primary-only'));
    const server = createProxyServer({
        baseUrlEnv: `http://127.0.0.1:${primary.address().port}`
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'other-client/1.0' },
            body: '{}'
        });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), 'primary-only');
        assert.equal(primary.calls(), 1);
    } finally {
        server.close();
        primary.close();
    }
});
