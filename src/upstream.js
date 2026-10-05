import http from 'node:http';
import https from 'node:https';

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
