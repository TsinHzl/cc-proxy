import http from 'node:http';
import https from 'node:https';
import { logger } from './logger.js';

// Upstream resolution: ANTHROPIC_BASE_URL wins, default official API.
const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

/**
 * Builds the upstream request target from the incoming request path.
 * @param {string} pathWithQuery - e.g. `/v1/messages?beta=true`
 * @param {string|undefined} baseUrlEnv - ANTHROPIC_BASE_URL value
 * @returns {{protocol: 'http:'|'https:', host: string, port: string, path: string}}
 */
export function resolveUpstream(pathWithQuery, baseUrlEnv) {
    const raw = (baseUrlEnv && baseUrlEnv.trim()) || DEFAULT_UPSTREAM;
    const url = new URL(raw.endsWith('/') ? raw.slice(0, -1) : raw);
    // A target that already ends with the endpoint path is used as-is
    // (claude-tap build_upstream_url semantics); otherwise append the path.
    const base = url.pathname === '/' ? '' : url.pathname;
    return {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        path: `${base}${pathWithQuery}`
    };
}

const RETRYABLE_STATUS = new Set([502, 503, 529]);
// 故障转移状态：在同上游重试耗尽后触发切换，额外覆盖限流（429）与 500，
// 独立于 RETRYABLE_STATUS（同上游重试仍只针对 502/503/529）。
// 导出供 proxy.js 埋点侧区分「触发故障转移的状态码」（熔断记败）与
// 「普通可达响应」（熔断记成功）。
export const FAILOVER_STATUS = new Set([429, 500, 502, 503, 529]);
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// 兼容两种 targets 元素形态：裸 target 对象（须含 host）→ { target }；
// 已含 target.host 的包装对象（{ target, headers?, name? }）原样使用。
// 非法条目（null / 非对象 / 缺 host）返回 null，由调用方过滤，防止
// labelOf 访问 entry.target.host 时抛错。
function toEntry(item) {
    if (item && typeof item === 'object' && !Array.isArray(item) && item.target
        && typeof item.target === 'object' && item.target.host) return item;
    if (item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.host === 'string' && item.host) return { target: item };
    return null;
}

/**
 * Forward with automatic retry on retryable upstream failures (5xx before
 * any response body is forwarded, or connection-level errors), then fail
 * over to the next target when retries are exhausted. Retries and failover
 * are transparent to the client: they happen before headers are written back.
 *
 * @param {http.IncomingMessage} req - incoming request (headers are copied)
 * @param {Buffer} bodyBuffer - request body to send upstream
 * @param {Array<{target: object, headers?: object, name?: string}|object>} targets
 *     ordered upstream list: first item is the primary upstream, each entry
 *     carries an optional per-upstream `headers` override merged into the
 *     request; a bare target object is accepted for the single-upstream case
 * @param {(upstreamRes: http.IncomingMessage) => void} respond
 * @param {(err: Error) => void} onError
 * @param {{isClientGone?: () => boolean, onFailover?: (fromName: string, toName: string, reason: string, toEntry?: {target: object, headers?: object, name?: string, base?: string}) => void, onProbe?: (upstreamName: string) => void}} [options]
 *     `onProbe`：某上游失败且请求即将切换到下一上游时上报（供熔断器记败）。
 *     末位上游的最终失败响应不经此上报——会原样交给 respond，由 proxy 按
 *     状态码归类，避免同一尝试重复计数。
 */
export function forwardRequestWithRetry(req, bodyBuffer, targets, respond, onError, { isClientGone = () => false, onFailover = null, onProbe = null } = {}) {
    const entries = (Array.isArray(targets) ? targets : [targets]).map(toEntry).filter(Boolean);
    const labelOf = (entry) => entry.name || entry.target.host;

    const attempt = (entryIdx, triesLeft) => {
        const entry = entries[entryIdx];
        const target = entry.target;
        // 客户端已断开时放弃重试，避免继续消耗上游配额。
        if (isClientGone()) return;
        // 切到下一上游；已无备用上游时返回 false，由调用方走最终错误路径。
        const switchToNext = (reason) => {
            if (entryIdx + 1 >= entries.length) return false;
            const next = entries[entryIdx + 1];
            logger.warn(`[cc-proxy] upstream ${labelOf(entry)} failed (${reason}), failing over to ${labelOf(next)}`);
            // 切换即视为当前上游本次尝试失败：先于 onFailover 上报（供熔断
            // 器记败），再通知埋点侧切换统计归属。第 4 参数携带切换目标
            // entry（含完整 base 等调用方附加字段），供定向缩放等需要完整
            // base URL 的消费方使用；既有 3 参数回调不受影响。
            if (onProbe) onProbe(labelOf(entry));
            if (onFailover) onFailover(labelOf(entry), labelOf(next), reason, next);
            attempt(entryIdx + 1, RETRY_DELAYS_MS.length);
            return true;
        };
        forwardRequest(req, bodyBuffer, target, (upstreamRes) => {
            // 不触发重试/转移的状态码（含成功与末位上游的最终失败）直接交给 respond。
            if (!FAILOVER_STATUS.has(upstreamRes.statusCode)) {
                respond(upstreamRes, bodyBuffer);
                return;
            }
            const retrySame = triesLeft > 0 && RETRYABLE_STATUS.has(upstreamRes.statusCode);
            if (!retrySame && !switchToNext(`HTTP ${upstreamRes.statusCode}`)) {
                // 全部上游耗尽：最后一个错误响应原样返回客户端。
                respond(upstreamRes, bodyBuffer);
                return;
            }
            if (isClientGone()) { upstreamRes.resume(); return; }
            upstreamRes.resume(); // drain and discard the error response
            upstreamRes.on('error', () => {}); // discarded response may still emit 'error'
            if (retrySame) {
                const delay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - triesLeft];
                logger.warn(`[cc-proxy] upstream ${upstreamRes.statusCode}, retrying in ${delay}ms (${triesLeft} left)`);
                setTimeout(() => attempt(entryIdx, triesLeft - 1), delay);
            }
        }, (err) => {
            if (triesLeft > 0) {
                const delay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - triesLeft];
                logger.warn(`[cc-proxy] upstream error: ${err.message}, retrying in ${delay}ms (${triesLeft} left)`);
                setTimeout(() => attempt(entryIdx, triesLeft - 1), delay);
                return;
            }
            // 连接级错误耗尽重试后：要么切换（记当前上游失败），要么最终失败。
            if (!switchToNext(err.message)) { if (onProbe) onProbe(labelOf(entry)); onError(err); }
        }, entry.headers);
    };
    attempt(0, RETRY_DELAYS_MS.length);
}

/**
 * Forwards an incoming request to the upstream target. The upstream response
 * is passed to `respond`, which owns writing it back to the client.
 *
 * @param {http.IncomingMessage} req - incoming request (headers are copied)
 * @param {Buffer} bodyBuffer - request body to send upstream
 * @param {{protocol: string, host: string, port: string, path: string}} target
 * @param {(upstreamRes: http.IncomingMessage) => void} respond
 * @param {(err: Error) => void} onError
 * @param {object} [extraHeaders] - per-upstream headers merged last (e.g. a
 *     failover upstream's own auth keys), overriding the copied request headers
 */
export function forwardRequest(req, bodyBuffer, target, respond, onError, extraHeaders) {
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, ...extraHeaders };
    headers.host = target.host;
    delete headers['content-length'];
    if (bodyBuffer && bodyBuffer.length) headers['content-length'] = Buffer.byteLength(bodyBuffer);

    const upstreamReq = transport.request(
        {
            protocol: target.protocol,
            hostname: target.host,
            port: target.port,
            method: req.method,
            path: target.path,
            headers
        },
        (upstreamRes) => respond(upstreamRes, bodyBuffer)
    );

    upstreamReq.on('error', (err) => onError(err));

    if (bodyBuffer && bodyBuffer.length) {
        upstreamReq.end(bodyBuffer);
    } else {
        upstreamReq.end();
    }
}
