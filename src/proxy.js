import http from 'node:http';
import { forwardRequestWithRetry, resolveUpstream } from './upstream.js';
import { logger } from './logger.js';
import {
    isClaudeCodeUserAgent,
    formatThinkingAsText,
    transformThinkingAsTextEvents,
    stripThinkingTextHistory
} from './thinking-text.js';
import { extractUsage, extractUsageFromResponseEvents, createUsageTracker } from './usage.js';
import { createDebugLog } from './debug-log.js';
import { isSuggestionModeRequest, buildSuggestionResponse, SUGGESTION_MARKER } from './suggestion-mode.js';

function parseEvent(raw) {
    const lines = raw.split('\n');
    const dataLines = [];
    for (const line of lines) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return null;
    try {
        return JSON.parse(dataLines.join('\n'));
    } catch {
        return null;
    }
}

function serializeEvent(data) {
    return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Suggestion Mode 拦截响应：按请求 stream 意图分流写 SSE 五事件或完整 JSON，
// 写完即 return（调用方不再走转发链路）。
function handleSuggestionIntercept(res, suggestionPayload) {
    const wantsStream = suggestionPayload.stream === true;
    const { body: suggestionBody, events: suggestionEvents } = buildSuggestionResponse(wantsStream);
    const headers = wantsStream
        ? { 'content-type': 'text/event-stream' }
        : { 'content-type': 'application/json' };
    res.writeHead(200, headers);
    if (wantsStream) {
        for (const event of suggestionEvents) res.write(serializeEvent(event));
    }
    res.end(suggestionBody);
}

// Writes one SSE event, waiting for the socket to drain when the client is
// slower than the upstream (a resolved promise on close, so a disconnected
// client cannot wedge the loop).
function writeEvent(res, data) {
    if (res.write(serializeEvent(data))) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
        };
        res.once('drain', done);
        res.once('close', done);
    });
}

// Non-streaming JSON responses: convert thinking content blocks to rendered
// dim-blockquote text blocks (signatures stripped), CC UA only.
function transformNonStreamingResponse(body) {
    let parsed;
    try {
        parsed = JSON.parse(body.toString('utf8'));
    } catch {
        return { body, usage: null };
    }
    if (parsed?.type !== 'message' || !Array.isArray(parsed.content)) {
        return { body, usage: extractUsage(parsed?.usage) };
    }

    let changed = false;
    const content = parsed.content.flatMap((block) => {
        if (block?.type !== 'thinking' || typeof block.thinking !== 'string') return [block];
        changed = true;
        const text = formatThinkingAsText(block.thinking);
        return [{ type: 'text', text }];
    });
    // 无 thinking 块时保留原始字节（避免多余重序列化改变转义/空白）；
    // usage 提取只需 parse，不需要重写 body。
    if (!changed) return { body, usage: extractUsage(parsed.usage) };
    parsed.content = content;
    return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), usage: extractUsage(parsed.usage) };
}

// Bridges upstream SSE bytes into a parsed-event async iterator with
// cross-chunk buffering (events are delimited by a blank line).
function createEventIterator(upstreamRes) {
    let buffer = '';
    const queue = [];
    let done = false;
    let notify = null;

    upstreamRes.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let sepIndex;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
            queue.push(buffer.slice(0, sepIndex));
            buffer = buffer.slice(sepIndex + 2);
        }
        if (notify) { const n = notify; notify = null; n(); }
    });
    const finish = () => { done = true; if (notify) { const n = notify; notify = null; n(); } };
    upstreamRes.on('end', finish);
    upstreamRes.on('error', finish);

    return {
        async next() {
            for (;;) {
                while (!queue.length && !done) {
                    await new Promise((resolve) => { notify = resolve; });
                }
                if (!queue.length) return { done: true };
                const event = parseEvent(queue.shift());
                // Unparsable or non-object payloads are dropped rather than
                // handed downstream: serializeEvent would throw on them and
                // kill the rest of the stream.
                if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
                    logger.warn('[cc-proxy] skipping unparsable SSE event');
                    continue;
                }
                return { value: event, done: false };
            }
        },
        [Symbol.asyncIterator]() { return this; }
    };
}

export function createProxyServer({ baseUrlEnv, usageTracker, debugLog, forwardSuggestionMode = false } = {}) {
    const usage = usageTracker ?? null;
    // 关闭态 debug-log 的方法为 null，归一为可调用的空实现，调用点无需判空。
    const rawDbg = debugLog ?? createDebugLog(); // 默认关闭：零开销空实现
    const dbg = {
        requestStart: rawDbg.requestStart ?? (() => null),
        recordEvent: rawDbg.recordEvent ?? (() => {}),
        requestEnd: rawDbg.requestEnd ?? (() => {})
    };
    return http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const bodyBuffer = Buffer.concat(chunks);
            const target = resolveUpstream(req.url, baseUrlEnv);
            const isClaudeCode = isClaudeCodeUserAgent(req.headers['user-agent']);
            const requestStartedAt = new Date();

            // Request-side history strip (CC UA only).
            let body = bodyBuffer;
            if (isClaudeCode && bodyBuffer.length) {
                try {
                    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
                    if (Array.isArray(parsed?.messages)) {
                        parsed.messages = stripThinkingTextHistory(parsed.messages);
                        body = Buffer.from(JSON.stringify(parsed), 'utf8');
                    }
                } catch {
                    // Not JSON — forward verbatim.
                }
            }

            // Suggestion Mode 拦截（CC UA、开关关闭时）：识别建议请求后直接
            // 返回结构完整的空响应，不转发上游；拦截路径零 usage 统计、零
            // debug 日志（该请求不产生任何上游消耗）。非命中或开关打开时走
            // 原有转发链路。includes 预筛避免主对话请求双重全量 JSON.parse。
            if (isClaudeCode && !forwardSuggestionMode && bodyBuffer.includes(SUGGESTION_MARKER)) {
                let suggestionPayload = null;
                try {
                    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
                    if (isSuggestionModeRequest(parsed)) suggestionPayload = parsed;
                } catch {
                    // Not JSON — normal forwarding path.
                }
                if (suggestionPayload) {
                    handleSuggestionIntercept(res, suggestionPayload);
                    return;
                }
            }

            forwardRequestWithRetry(req, body, target, (upstreamRes) => {
                const contentType = upstreamRes.headers['content-type'] || '';
                const responseIsSse = contentType.includes('text/event-stream');
                const logStream = dbg.requestStart(req, bodyBuffer);

                // Non-CC clients: everything verbatim.
                if (!isClaudeCode) {
                    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
                    upstreamRes.pipe(res);
                    // 收尾覆盖正常结束 / 上游错误 / 客户端断开三条路径，
                    // 防止日志写流未关闭导致 fd 泄漏（requestEnd 幂等）。
                    const finishLog = () => dbg.requestEnd(logStream, upstreamRes.statusCode, requestStartedAt);
                    upstreamRes.on('end', finishLog);
                    upstreamRes.on('error', finishLog);
                    res.on('close', finishLog);
                    return;
                }

                // CC client + non-SSE response: buffer, then rewrite thinking
                // blocks if the body is a message JSON (others pass through).
                if (!responseIsSse) {
                    const bodyChunks = [];
                    upstreamRes.on('data', (c) => bodyChunks.push(c));
                    upstreamRes.on('error', () => { if (!res.headersSent) res.end(); });
                    upstreamRes.on('end', () => {
                        const { body: out, usage: respUsage } = transformNonStreamingResponse(Buffer.concat(bodyChunks));
                        const headers = { ...upstreamRes.headers };
                        // Body is re-framed: drop the upstream chunked framing,
                        // otherwise content-length conflicts with it.
                        delete headers['transfer-encoding'];
                        headers['content-length'] = Buffer.byteLength(out);
                        res.writeHead(upstreamRes.statusCode, headers);
                        res.end(out);
                        if (usage) usage.record(respUsage);
                        dbg.requestEnd(logStream, upstreamRes.statusCode, requestStartedAt);
                    });
                    return;
                }

                // CC client + SSE: rewrite thinking blocks to text.
                const headers = { ...upstreamRes.headers };
                delete headers['content-length'];
                res.writeHead(upstreamRes.statusCode, headers);

                const events = createEventIterator(upstreamRes);
                void (async () => {
                    try {
                        const collected = [];
                        for await (const event of transformThinkingAsTextEvents(events, { thinkingAsText: true })) {
                            if (usage || logStream) {
                                // message_start/message_delta 之外的样本不参与统计，仅必要时保留以省内存。
                                if (event.type === 'message_start' || event.type === 'message_delta') collected.push(event);
                                dbg.recordEvent(logStream, event);
                            }
                            await writeEvent(res, event);
                        }
                        res.end();
                        if (usage) usage.record(extractUsageFromResponseEvents(collected));
                        dbg.requestEnd(logStream, upstreamRes.statusCode, requestStartedAt);
                    } catch (err) {
                        logger.error('[cc-proxy] stream transform failed:', err.message);
                        res.end();
                        dbg.requestEnd(logStream, `error: ${err.message}`, requestStartedAt);
                    }
                })();
            }, (err) => {
                logger.error('[cc-proxy] upstream error:', err.message);
                // 连接级失败（未收到上游响应）也落盘：排查网关兼容性最需要这段。
                const logStream = dbg.requestStart(req, bodyBuffer);
                dbg.requestEnd(logStream, `upstream error: ${err.message}`, requestStartedAt);
                if (res.headersSent) { res.end(); return; }
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: { type: 'api_error', message: `upstream request failed: ${err.message}` }
                }));
            }, { isClientGone: () => res.destroyed || res.writableEnded });
        });
    });
}
