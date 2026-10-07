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
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Forward with automatic retry on retryable upstream failures (5xx before
 * any response body is forwarded, or connection-level errors). Retries are
 * transparent to the client: they happen before headers are written back.
 *
 * @param {http.IncomingMessage} req - incoming request (headers are copied)
 * @param {Buffer} bodyBuffer - request body to send upstream
 * @param {{protocol: string, host: string, port: string, path: string}} target
 * @param {(upstreamRes: http.IncomingMessage) => void} respond
 * @param {(err: Error) => void} onError
 */
export function forwardRequestWithRetry(req, bodyBuffer, target, respond, onError, { isClientGone = () => false } = {}) {
    const attempt = (triesLeft) => {
        // 客户端已断开时放弃重试，避免继续消耗上游配额。
        if (isClientGone()) return;
        forwardRequest(req, bodyBuffer, target, (upstreamRes) => {
            // Retry only while nothing has been forwarded to the client yet;
            // once headers are handed to `respond`, the stream is committed.
            if (RETRYABLE_STATUS.has(upstreamRes.statusCode) && triesLeft > 0) {
                if (isClientGone()) { upstreamRes.resume(); return; }
                upstreamRes.resume(); // drain and discard the error response
                upstreamRes.on('error', () => {}); // discarded response may still emit 'error'
                const delay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - triesLeft];
                logger.warn(`[cc-proxy] upstream ${upstreamRes.statusCode}, retrying in ${delay}ms (${triesLeft} left)`);
                setTimeout(() => attempt(triesLeft - 1), delay);
                return;
            }
            respond(upstreamRes, bodyBuffer);
        }, (err) => {
            if (triesLeft > 0) {
                const delay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - triesLeft];
                logger.warn(`[cc-proxy] upstream error: ${err.message}, retrying in ${delay}ms (${triesLeft} left)`);
                setTimeout(() => attempt(triesLeft - 1), delay);
                return;
            }
            onError(err);
        });
    };
    attempt(RETRY_DELAYS_MS.length);
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
 */
export function forwardRequest(req, bodyBuffer, target, respond, onError) {
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers };
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
