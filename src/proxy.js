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
import { buildOverriddenSystem } from './system-prompt.js';
import { createLatencyTracker } from './latency.js';

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

// 流式路径：从 collected 的 message_start 事件取 model（usage 按模型分组用）。
function extractModelFromResponseEvents(events) {
    for (const event of events) {
        const model = event?.type === 'message_start' ? event.message?.model : null;
        if (typeof model === 'string' && model) return model;
    }
    return null;
}

// Non-streaming JSON responses: convert thinking content blocks to rendered
// dim-blockquote text blocks (signatures stripped), CC UA only.
function transformNonStreamingResponse(body, thinkingAsText) {
    let parsed;
    try {
        parsed = JSON.parse(body.toString('utf8'));
    } catch {
        return { body, usage: null, model: null };
    }
    const model = typeof parsed?.model === 'string' && parsed.model ? parsed.model : null;
    if (!thinkingAsText) return { body, usage: extractUsage(parsed?.usage), model };
    if (parsed?.type !== 'message' || !Array.isArray(parsed.content)) {
        return { body, usage: extractUsage(parsed?.usage), model };
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
    if (!changed) return { body, usage: extractUsage(parsed.usage), model };
    parsed.content = content;
    return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), usage: extractUsage(parsed.usage), model };
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

export function createProxyServer({
    baseUrlEnv,
    usageTracker,
    latencyTracker = createLatencyTracker(),
    debugLog,
    forwardSuggestionMode = false,
    thinkingAsText = true,
    effortOverride = null,
    systemPromptOverride = null,
    systemPromptCapture = null,
    upstreamHealth = null,
    failoverUpstreams = []
} = {}) {
    // 备用上游启动时解析一次并固定（不热加载）：baseUrl 复用主上游的
    // resolveUpstream 语义取 base 路径前缀，请求侧再拼接实际 path；
    // headers/name 逐项透传给转发层。
    const failoverBases = (Array.isArray(failoverUpstreams) ? failoverUpstreams : [])
        .map((item) => {
            try {
                const base = resolveUpstream('', item.baseUrl);
                return {
                    base: { protocol: base.protocol, host: base.host, port: base.port },
                    basePath: base.path,
                    headers: item.headers,
                    name: item.name
                };
            } catch {
                // 非法 baseUrl（配置写入侧已过滤，此处兜底）跳过该项，不让
                // 单条坏配置阻塞代理启动。
                logger.warn(`[cc-proxy] skipping failover upstream with invalid baseUrl`);
                return null;
            }
        })
        .filter(Boolean);

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
            // targets 列表：首项主上游，其后为备用上游（同 path 拼接、各自 headers）。
            const targets = [
                target,
                ...failoverBases.map((f) => ({
                    target: { protocol: f.base.protocol, host: f.base.host,
                        port: f.base.port, path: `${f.basePath}${req.url}` },
                    headers: f.headers,
                    name: f.name
                }))
            ];

            const isClaudeCode = isClaudeCodeUserAgent(req.headers['user-agent']);
            const requestStartedAt = new Date();

            // Request-side history strip (CC UA only).
            let body = bodyBuffer;
            if (isClaudeCode && bodyBuffer.length) {
                try {
                    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
                    // Suggestion Mode 预筛后的捕获：非建议请求对覆写前的原始
                    // system 捕获（先捕获后覆写、与开关状态无关——覆写开启期
                    // 间继续捕获原始值，保证 CC 默认提示词变化时捕获文件仍能
                    // 更新且不被自定义 prompt 污染）。捕获全程静默容错，不影响
                    // 转发。复用本次 JSON.parse，不额外解析。
                    if (systemPromptCapture && !bodyBuffer.includes(SUGGESTION_MARKER)
                        && !isSuggestionModeRequest(parsed)) {
                        systemPromptCapture.capture(parsed.system);
                    }
                    if (Array.isArray(parsed?.messages)) {
                        parsed.messages = stripThinkingTextHistory(parsed.messages);
                        body = Buffer.from(JSON.stringify(parsed), 'utf8');
                    }
                    // Effort 覆写：开关开启时无论 CC 本地设置如何，均以配置档位
                    // 覆盖 output_config.effort（CC 当前实际形态）并兜底覆写
                    // top-level effort；仅在覆写生效时重序列化 body。
                    if (effortOverride?.enabled) {
                        parsed.output_config = { ...parsed.output_config, effort: effortOverride.level };
                        parsed.effort = effortOverride.level;
                        body = Buffer.from(JSON.stringify(parsed), 'utf8');
                    }
                    // 系统提示词覆写：enabled 且 prompt 非空且原 system 存在时，
                    // 将 system 替换为配置文本（保留原首块 cache_control）。
                    // prompt 为空或 system 缺失时按 no-op 字节透传。
                    const prompt = systemPromptOverride?.prompt;
                    if (systemPromptOverride?.enabled && typeof prompt === 'string' && prompt
                        && parsed.system !== undefined) {
                        const overridden = buildOverriddenSystem(parsed.system, prompt);
                        if (overridden !== null) {
                            parsed.system = overridden;
                            body = Buffer.from(JSON.stringify(parsed), 'utf8');
                        }
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

            // 采样防重：sampled 标志覆盖成功收尾与连接错误回调；ttfbAt 由
            // 响应回调写入（上游响应头到达，含 failover 重试耗时，即用户
            // 感知的首字节口径），连接失败路径保持 0（无真实 TTFB）。
            let sampled = false;
            let ttfbAt = 0;
            // 上游健康埋点：activeUpstreamId 跟随故障转移切换（onFailover 更新），
            // 响应头到达 / 失败回调据此归属统计。
            let activeUpstreamId = target.host;
            const recordUpstreamHealth = (ok, ttftMs = null) => {
                if (!upstreamHealth) return;
                if (ok) {
                    upstreamHealth.recordRequest(activeUpstreamId, { ok: true, ttftMs });
                } else {
                    // 流中失败：请求已由响应头到达时的成功样本计数，这里仅补记
                    // failures，避免 requests 分母重复计数。
                    upstreamHealth.recordFailure(activeUpstreamId);
                }
            };
            const recordLatency = (status) => {
                if (sampled) return;
                sampled = true;
                // 失败路径（status 0）没有真实 TTFB，ttftMs 恒为 ~0，仅 totalMs
                // 反映实际等待/失败耗时；status 0 表示该样本不计入首字节口径。
                latencyTracker.sample({
                    ttftMs: ttfbAt ? ttfbAt - requestStartedAt.getTime() : 0,
                    totalMs: Date.now() - requestStartedAt.getTime(),
                    status
                });
            };

            forwardRequestWithRetry(req, body, targets, (upstreamRes) => {
                const contentType = upstreamRes.headers['content-type'] || '';
                const responseIsSse = contentType.includes('text/event-stream');
                const logStream = dbg.requestStart(req, bodyBuffer);
                ttfbAt = Date.now();
                // 响应头到达即记成功样本（含最终返回 4xx/5xx 的上���——该上游
                // 本身可达，连接面是健康的）。
                recordUpstreamHealth(true, ttfbAt - requestStartedAt.getTime());

                // Non-CC clients: everything verbatim.
                if (!isClaudeCode) {
                    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
                    upstreamRes.pipe(res);
                    // 收尾覆盖正常结束 / 上游错误 / 客户端断开三条路径，
                    // 防止日志写流未关闭导致 fd 泄漏（requestEnd 幂等）。
                    // 非 CC UA 为原样透传路径，不参与延迟统计（提案范围外）。
                    const finishLog = () => dbg.requestEnd(logStream, upstreamRes.statusCode, requestStartedAt);
                    upstreamRes.on('end', finishLog);
                    res.on('close', finishLog);
                    return;
                }

                // CC client + non-SSE response: buffer, then rewrite thinking
                // blocks if the body is a message JSON (others pass through).
                if (!responseIsSse) {
                    const bodyChunks = [];
                    upstreamRes.on('data', (c) => bodyChunks.push(c));
                    // 失败路径也采样（status 0 = 无有效响应哨兵），避免失败请求
                    // 从统计中静默消失导致 p50/p95 偏乐观。
                    upstreamRes.on('error', () => {
                        recordLatency(0);
                        recordUpstreamHealth(false);
                        if (!res.headersSent) res.end();
                    });
                    upstreamRes.on('end', () => {
                        const { body: out, usage: respUsage, model: parsedModel } = transformNonStreamingResponse(
                            Buffer.concat(bodyChunks),
                            thinkingAsText
                        );
                        const headers = { ...upstreamRes.headers };
                        // Body is re-framed: drop the upstream chunked framing,
                        // otherwise content-length conflicts with it.
                        delete headers['transfer-encoding'];
                        headers['content-length'] = Buffer.byteLength(out);
                        res.writeHead(upstreamRes.statusCode, headers);
                        res.end(out);
                        if (usage) usage.record(respUsage, parsedModel);
                        recordLatency(upstreamRes.statusCode);
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
                        // 计时锚点：请求到达代理的时刻，把网关侧缓冲也计入思考时长。
                        for await (const event of transformThinkingAsTextEvents(events, {
                            thinkingAsText,
                            startedAtMs: requestStartedAt.getTime()
                        })) {
                            if (usage || logStream) {
                                // message_start/message_delta 之外的样本不参与统计，仅必要时保留以省内存。
                                if (event.type === 'message_start' || event.type === 'message_delta') collected.push(event);
                                dbg.recordEvent(logStream, event);
                            }
                            await writeEvent(res, event);
                        }
                        res.end();
                        if (usage) {
                            usage.record(
                                extractUsageFromResponseEvents(collected),
                                extractModelFromResponseEvents(collected)
                            );
                        }
                        recordLatency(upstreamRes.statusCode);
                        dbg.requestEnd(logStream, upstreamRes.statusCode, requestStartedAt);
                    } catch (err) {
                        logger.error('[cc-proxy] stream transform failed:', err.message);
                        res.end();
                        // 流已失败，状态码不再可信，记 0 哨兵而非上游 200。
                        recordLatency(0);
                        // 客户端主动断开（Ctrl+C/断连）不是上游故障，不计失败。
                        if (!res.destroyed && !res.writableEnded) recordUpstreamHealth(false);
                        dbg.requestEnd(logStream, `error: ${err.message}`, requestStartedAt);
                    }
                })();
            }, (err) => {
                logger.error('[cc-proxy] upstream error:', err.message);
                // 连接级失败（未收到上游响应）计入失败样本。
                recordUpstreamHealth(false);
                // 连接级失败（未收到上游响应）也落盘：排查网关兼容性最需要这段。
                const logStream = dbg.requestStart(req, bodyBuffer);
                dbg.requestEnd(logStream, `upstream error: ${err.message}`, requestStartedAt);
                // 连接失败同样计入延迟统计（status 0 = 无有效响应哨兵）。
                recordLatency(0);
                if (res.headersSent) { res.end(); return; }
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: { type: 'api_error', message: `upstream request failed: ${err.message}` }
                }));
            }, {
                isClientGone: () => res.destroyed || res.writableEnded,
                // 故障转移埋点：切换事件（时间+原因）入环形缓冲，后续样本归属新上游。
                onFailover: (from, to, reason) => {
                    if (!upstreamHealth) return;
                    upstreamHealth.recordFailover(from, to, reason);
                    activeUpstreamId = to;
                }
            });
        });
    });
}
