// Debug 请求日志：CC_PROXY_DEBUG=1 时把每个请求的 method/url/status/耗时、
// 请求体与 SSE 事件流落盘到 ~/.cc-proxy/logs/，用于排查第三方网关兼容性。
// 容错策略：任何写失败静默丢弃，绝不影响代理流量；关闭时零开销零文件。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function defaultDebugLogDir() {
    return path.join(os.homedir(), '.cc-proxy', 'logs');
}

export function isDebugEnabled(env = process.env) {
    return env.CC_PROXY_DEBUG === '1';
}

export function createDebugLog({ dir = defaultDebugLogDir(), enabled = isDebugEnabled(), now = () => new Date() } = {}) {
    if (!enabled) return { requestStart: null, recordEvent: null, requestEnd: null };

    let seq = 0;
    const stamp = now().toISOString().replace(/[:.]/g, '-');

    // 每个请求一个文件：<stamp>-<seq>-<method>-<path>.log
    const openLogFile = (req) => {
        seq += 1;
        const urlPath = (req.url || '/').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
        const name = `${stamp}-${String(seq).padStart(4, '0')}-${req.method || 'GET'}${urlPath}.log`;
        try {
            fs.mkdirSync(dir, { recursive: true });
            // 0o600：日志可能含用户粘贴的代码/凭据，仅属主可读写。
            const stream = fs.createWriteStream(path.join(dir, name), { flags: 'a', mode: 0o600 });
            // 写流错误（磁盘满/权限变更/write-after-end）是异步事件，必须挂
            // 监听兜底，否则会以未捕获异常终止整个代理进程。
            stream.on('error', () => {});
            return stream;
        } catch {
            return null;
        }
    };

    const writeLine = (stream, line) => {
        if (!stream || stream.destroyed || stream.writableEnded) return;
        // 写失败静默丢弃；背压交由 Node 内部缓冲（受 highWaterMark 约束），
        // debug 数据让位于代理流量。
        try {
            stream.write(line + '\n');
        } catch {
            // 写失败静默：debug 日志绝不能影响代理。
        }
    };

    return {
        // 请求开始：记录元信息 + 请求体（headers 中的 key 脱敏，只保留名称）。
        requestStart(req, bodyBuffer) {
            const stream = openLogFile(req);
            if (!stream) return null;
            writeLine(stream, `# ${now().toISOString()} ${req.method} ${req.url}`);
            for (const [name] of Object.entries(req.headers)) {
                writeLine(stream, `> ${name}`);
            }
            if (bodyBuffer?.length) {
                writeLine(stream, `# request body (${bodyBuffer.length} bytes)`);
                writeLine(stream, bodyBuffer.toString('utf8').slice(0, 512 * 1024));
            }
            return stream;
        },

        // SSE 事件逐条落盘。
        recordEvent(stream, event) {
            writeLine(stream, `< ${JSON.stringify(event)}`);
        },

        // 请求结束：记录状态与耗时并关流。
        requestEnd(stream, statusCode, startedAtMs) {
            if (!stream || stream.destroyed || stream.writableEnded) return;
            const ms = startedAtMs == null ? '?' : Math.round(now().getTime() - startedAtMs.getTime());
            writeLine(stream, `# status=${statusCode} duration=${ms}ms`);
            stream.end();
        }
    };
}
