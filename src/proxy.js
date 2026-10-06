import http from 'node:http';
import { resolveUpstream, forwardRequest } from './upstream.js';
import { logger } from './logger.js';
import {
    isClaudeCodeUserAgent,
    formatThinkingAsText,
    transformThinkingAsTextEvents,
    stripThinkingTextHistory
} from './thinking-text.js';

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
        return body;
    }
    if (parsed?.type !== 'message' || !Array.isArray(parsed.content)) return body;

    let changed = false;
    const content = parsed.content.flatMap((block) => {
        if (block?.type !== 'thinking' || typeof block.thinking !== 'string') return [block];
        changed = true;
        const text = formatThinkingAsText(block.thinking);
        return [{ type: 'text', text }];
    });
    if (!changed) return body;

    parsed.content = content;
    return Buffer.from(JSON.stringify(parsed), 'utf8');
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

export function createProxyServer({ baseUrlEnv } = {}) {
    return http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const bodyBuffer = Buffer.concat(chunks);
            const target = resolveUpstream(req.url, baseUrlEnv);
            const isClaudeCode = isClaudeCodeUserAgent(req.headers['user-agent']);

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

            forwardRequest(req, body, target, (upstreamRes) => {
                const contentType = upstreamRes.headers['content-type'] || '';
                const responseIsSse = contentType.includes('text/event-stream');

                // Non-CC clients: everything verbatim.
                if (!isClaudeCode) {
                    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
                    upstreamRes.pipe(res);
                    return;
                }

                // CC client + non-SSE response: buffer, then rewrite thinking
                // blocks if the body is a message JSON (others pass through).
                if (!responseIsSse) {
                    const bodyChunks = [];
                    upstreamRes.on('data', (c) => bodyChunks.push(c));
                    upstreamRes.on('error', () => { if (!res.headersSent) res.end(); });
                    upstreamRes.on('end', () => {
                        const out = transformNonStreamingResponse(Buffer.concat(bodyChunks));
                        const headers = { ...upstreamRes.headers };
                        // Body is re-framed: drop the upstream chunked framing,
                        // otherwise content-length conflicts with it.
                        delete headers['transfer-encoding'];
                        headers['content-length'] = Buffer.byteLength(out);
                        res.writeHead(upstreamRes.statusCode, headers);
                        res.end(out);
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
                        for await (const event of transformThinkingAsTextEvents(events, { thinkingAsText: true })) {
                            await writeEvent(res, event);
                        }
                        res.end();
                    } catch (err) {
                        logger.error('[cc-proxy] stream transform failed:', err.message);
                        res.end();
                    }
                })();
            }, (err) => {
                logger.error('[cc-proxy] upstream error:', err.message);
                if (res.headersSent) { res.end(); return; }
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: { type: 'api_error', message: `upstream request failed: ${err.message}` }
                }));
            });
        });
    });
}
