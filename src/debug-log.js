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
            return fs.createWriteStream(path.join(dir, name), { flags: 'a' });
        } catch {
            return null;
        }
    };

    const writeLine = (stream, line) => {
        if (!stream) return;
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
            if (!stream) return;
            const ms = startedAtMs == null ? '?' : Math.round(now().getTime() - startedAtMs.getTime());
            writeLine(stream, `# status=${statusCode} duration=${ms}ms`);
            stream.end();
        }
    };
}
