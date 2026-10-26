import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readConfig, writeConfig } from '../src/settings.js';
import { defaultUsagePath, readRecentDays } from '../src/usage.js';
import { createUsageStore } from '../src/usage-store.js';
import { readHealthSnapshot, defaultHealthPath } from '../src/upstream-health.js';
import { readRequestLog, defaultRequestLogPath } from '../src/request-log.js';
import { estimateCost, cacheHitRate, computeUsageAlert } from '../src/pricing.js';
import { createSystemPromptCapture, capturedSystemPromptPath } from '../src/system-prompt.js';
import {
    SESSION_TIMING,
    createSessionLifecycle
} from './settings-session.js';
import { renderSettingsPage } from './settings-page.js';

export { SESSION_TIMING, createSessionLifecycle, renderSettingsPage };

// PATCH 正文上限：systemPromptOverride.prompt 校验上限 256KB + 64KB JSON
// 包装/转义余量，确保任何通过配置校验的 prompt 均可经设置页提交。
const MAX_BODY_BYTES = 327_680;
const BODY_TIMEOUT_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
const BOOTSTRAP_NONCE_TTL_MS = 30_000;
const MAX_BOOTSTRAP_NONCES = 256;
// 自定义系统提示词上限：与 src/settings.js 的 MAX_PROMPT_BYTES 一致。
const MAX_PROMPT_BYTES = 256 * 1024;
const ALLOWED_KEYS = new Set([
    'forwardSuggestionMode',
    'thinkingAsText',
    'effortOverride.enabled',
    'effortOverride.level',
    'effortOverride.baseUrls',
    'systemPromptOverride.enabled',
    'systemPromptOverride.prompt',
    'usageScale.enabled',
    'usageScale.ratio',
    'usageScale.baseUrls'
]);
// effort 档位枚举单点定义（与 src/settings.js 的 EFFORT_LEVELS 保持一致）。
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);

function tokenMatches(actual, expected) {
    if (typeof actual !== 'string') return false;
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function commonHeaders(extra = {}) {
    return {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...extra
    };
}

function sendJson(res, status, payload, extra = {}, onFlushed) {
    const body = JSON.stringify(payload);
    res.writeHead(status, commonHeaders({
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        ...extra
    }));
    res.end(body, onFlushed);
}

function publicSettings(config) {
    return {
        forwardSuggestionMode: config.forwardSuggestionMode,
        thinkingAsText: config.thinkingAsText,
        effortOverride: config.effortOverride,
        systemPromptOverride: config.systemPromptOverride,
        usageScale: config.usageScale
    };
}

function issueBootstrapNonce({
    bootstrapNonces,
    createBootstrapNonce,
    bootstrapNonceTtlMs,
    maxBootstrapNonces,
    now
}) {
    const currentTime = now();
    for (const [nonce, expiresAt] of bootstrapNonces) {
        if (expiresAt <= currentTime) bootstrapNonces.delete(nonce);
    }
    while (bootstrapNonces.size >= maxBootstrapNonces) {
        const oldestNonce = bootstrapNonces.keys().next().value;
        bootstrapNonces.delete(oldestNonce);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const nonce = createBootstrapNonce();
        if (bootstrapNonces.has(nonce)) continue;
        bootstrapNonces.set(nonce, currentTime + bootstrapNonceTtlMs);
        return nonce;
    }
    throw new Error('无法生成唯一的 Bootstrap nonce');
}

async function handleBootstrapRequest(context, req, res, host) {
    if (req.method !== 'POST') {
        sendJson(
            res,
            405,
            { ok: false, error: '请求方法不支持' },
            { allow: 'POST' }
        );
        return;
    }
    if (req.headers.origin !== `http://${host}`) {
        sendJson(res, 403, { ok: false, error: '请求来源无效' });
        return;
    }
    const contentType = req.headers['content-type'] || '';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
        sendJson(res, 415, { ok: false, error: '仅支持 JSON' });
        return;
    }

    const bodyResult = await readJsonBodyOrRespond(
        context,
        req,
        res
    );
    if (!bodyResult.ok) return;
    const body = bodyResult.value;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.nonce !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Bootstrap 请求无效' });
        return;
    }

    const expiresAt = context.bootstrapNonces.get(body.nonce);
    if (expiresAt === undefined || expiresAt <= context.now()) {
        if (expiresAt !== undefined) context.bootstrapNonces.delete(body.nonce);
        sendJson(res, 401, { ok: false, error: '未授权' });
        return;
    }
    context.bootstrapNonces.delete(body.nonce);
    sendJson(res, 200, {
        ok: true,
        data: { token: context.token }
    });
}

function createBodyError(message, statusCode, destroyAfterResponse = false) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.destroyAfterResponse = destroyAfterResponse;
    return error;
}

function bodyErrorMessage(statusCode) {
    if (statusCode === 413) return '请求体过大';
    if (statusCode === 408) return '请求体读取超时';
    return '请求体无效';
}

function bodyErrorCleanup(req, error) {
    if (!error.destroyAfterResponse) return undefined;
    return () => {
        if (!req.destroyed) req.destroy();
    };
}

async function readJsonBodyOrRespond(context, req, res) {
    try {
        return {
            ok: true,
            value: await readJsonBody(req, context)
        };
    } catch (error) {
        sendJson(res, error.statusCode ?? 400, {
            ok: false,
            error: bodyErrorMessage(error.statusCode)
        }, {}, bodyErrorCleanup(req, error));
        return { ok: false };
    }
}

function readJsonBody(req, {
    bodyTimeoutMs,
    scheduleBodyTimeout,
    cancelBodyTimeout
}) {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength)
        && contentLength > MAX_BODY_BYTES) {
        req.resume();
        return Promise.reject(
            createBodyError('body too large', 413)
        );
    }

    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        let timer;

        const cleanup = () => {
            cancelBodyTimeout(timer);
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
            req.off('aborted', onAborted);
        };
        const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
        };
        const fail = (error) => {
            if (error.destroyAfterResponse) req.pause?.();
            settle(reject, error);
        };
        const onData = (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                chunks.length = 0;
                fail(createBodyError('body too large', 413, true));
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = () => {
            try {
                settle(
                    resolve,
                    JSON.parse(Buffer.concat(chunks).toString('utf8'))
                );
            } catch {
                fail(createBodyError('invalid json', 400));
            }
        };
        const onError = () => {
            fail(createBodyError('body read failed', 400));
        };
        const onAborted = () => {
            fail(createBodyError('body aborted', 400));
        };

        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('aborted', onAborted);
        timer = scheduleBodyTimeout(() => {
            fail(createBodyError('body timeout', 408, true));
        }, bodyTimeoutMs);
    });
}

function parseRequestUrl(req, res, host) {
    try {
        return new URL(req.url, `http://${host}`);
    } catch {
        sendJson(res, 400, {
            ok: false,
            error: '请求地址无效'
        });
        return null;
    }
}

function handlePageRequest(context, req, res, url) {
    if (url.pathname !== '/') return false;
    if (req.method !== 'GET') {
        sendJson(
            res,
            405,
            { ok: false, error: '请求方法不支持' },
            { allow: 'GET' }
        );
        return true;
    }

    const body = renderSettingsPage(issueBootstrapNonce(context));
    res.writeHead(200, commonHeaders({
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer'
    }));
    res.end(body);
    return true;
}

async function handleSessionRequest(context, req, res, url) {
    if (url.pathname !== '/api/session') return false;
    if (req.method !== 'GET') {
        sendJson(
            res,
            405,
            { ok: false, error: '请求方法不支持' },
            { allow: 'GET' }
        );
        return true;
    }
    if (context.onSession) await context.onSession(req, res);
    else {
        sendJson(res, 501, {
            ok: false,
            error: '会话服务未启用'
        });
    }
    return true;
}

// 单值 base URL 校验：字符串且 trim 后非空、可 new URL 解析、协议限
// http/https。usageScale / effortOverride 两个校验入口共用。
function isHttpUrl(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text) return false;
    try {
        const u = new URL(text);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

// usageScale.baseUrls 校验：混合数组——字符串项须为合法 http(s) URL；
// 对象项须为非数组对象、url 合法、ratio 若存在须为有限数 ∈ (0,10]。任一
// 非法项整次提交判 400（与 settings.js cleanScaleTargets 同口径，差异在于
// 此处判 400 而非静默丢弃）。
function isValidScaleTargetArray(value) {
    if (!Array.isArray(value)) return false;
    return value.every((item) => {
        if (typeof item === 'string') return isHttpUrl(item);
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
        if (!isHttpUrl(item.url)) return false;
        if (item.ratio === undefined) return true;
        return isValidScaleRatio(item.ratio);
    });
}

// 数值比例校验：有限数且 ∈ (0,10]（与 usageScale.ratio 全局值同值域）。
function isValidScaleRatio(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10;
}

// effortOverride.baseUrls 校验：混合数组——字符串项须为合法 http(s) URL；
// 对象项须为非数组对象、url 合法、level 若存在须 ∈ EFFORT_LEVELS。任一非法
// 项整次提交判 400（与 settings.js cleanEffortTargets 同口径，差异在于此处
// 判 400 而非静默丢弃）。
function isValidEffortTargetArray(value) {
    if (!Array.isArray(value)) return false;
    return value.every((item) => {
        if (typeof item === 'string') return isHttpUrl(item);
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
        if (!isHttpUrl(item.url)) return false;
        return item.level === undefined || EFFORT_LEVELS.has(item.level);
    });
}

// 点号 key（effortOverride.* / systemPromptOverride.*）按 key 分流校验
// value 类型；顶层布尔 key 维持原有布尔校验。
function isValidSettingsPatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (Object.keys(body).length !== 2 || !ALLOWED_KEYS.has(body.key)) return false;
    if (body.key === 'effortOverride.level') {
        return EFFORT_LEVELS.has(body.value);
    }
    if (body.key === 'systemPromptOverride.prompt') {
        return typeof body.value === 'string'
            && Buffer.byteLength(body.value, 'utf8') <= MAX_PROMPT_BYTES;
    }
    if (body.key === 'usageScale.ratio') {
        // 与 settings.js normalizeConfig 同口径：有限数 (0, 10]。
        return typeof body.value === 'number' && Number.isFinite(body.value)
            && body.value > 0 && body.value <= 10;
    }
    if (body.key === 'usageScale.baseUrls') return isValidScaleTargetArray(body.value);
    if (body.key === 'effortOverride.baseUrls') return isValidEffortTargetArray(body.value);
    return typeof body.value === 'boolean';
}

function hasJsonContentType(req) {
    const contentType = req.headers['content-type'] || '';
    return contentType
        .split(';', 1)[0]
        .trim()
        .toLowerCase() === 'application/json';
}

async function handleSettingsPatch(context, req, res, host) {
    if (req.headers.origin !== `http://${host}`) {
        sendJson(res, 403, {
            ok: false,
            error: '请求来源无效'
        });
        return;
    }
    if (!hasJsonContentType(req)) {
        sendJson(res, 415, {
            ok: false,
            error: '仅支持 JSON'
        });
        return;
    }

    const bodyResult = await readJsonBodyOrRespond(
        context,
        req,
        res
    );
    if (!bodyResult.ok) return;
    const body = bodyResult.value;
    if (!isValidSettingsPatch(body)) {
        sendJson(res, 400, {
            ok: false,
            error: '设置字段无效'
        });
        return;
    }

    try {
        // 点号 key 展开为嵌套 partial（{ effortOverride: { level: value } }），
        // 顶层 key 直接映射，writeConfig 逐字段合并保留未提交字段。
        const [group, leaf] = body.key.split('.');
        // baseUrls 在边界处按 group 归一：usageScale 为混合数组，字符串项
        // trim，对象项只保留 url / ratio 两键（丢弃 ratio 缺失时的 undefined
        // 键，避免落盘出现空比例字段），与 settings.js cleanScaleTargets 的
        // 落盘口径一致；effortOverride 同样只保留 url / level 两键。
        const value = body.key === 'usageScale.baseUrls'
            ? body.value.map((item) => {
                if (typeof item === 'string') return item.trim();
                return item.ratio === undefined
                    ? { url: item.url.trim() }
                    : { url: item.url.trim(), ratio: item.ratio };
            })
            : body.key === 'effortOverride.baseUrls'
                ? body.value.map((item) => {
                    if (typeof item === 'string') return item.trim();
                    return item.level === undefined
                        ? { url: item.url.trim() }
                        : { url: item.url.trim(), level: item.level };
                })
                : body.value;
        const patch = leaf
            ? { [group]: { [leaf]: value } }
            : { [body.key]: value };
        const config = await context.write(patch);
        sendJson(res, 200, {
            ok: true,
            data: publicSettings(config)
        });
    } catch {
        sendJson(res, 500, {
            ok: false,
            error: '保存设置失败'
        });
    }
}

// GET /api/usage：近 30 天用量看板明细（token/请求数/按模型分组/命中率/费用/告警），
// 前端按 Tab（今日/七天/一个月）切片渲染。
// 费用为保守估算：任一模型定价缺失即整日费用置 null（未知价模型费用不可信，
// 部分求和会低估），全部模型可定价才给出总和；当日无任何模型时 cost 为 null。
// 注：用量数据固定读全局 ~/.cc-proxy（不做 envDir 覆盖），与 config 的 envDir
// 语义独立 —— 用量始终全局累计。usageStore 为注入的存储抽象层（缺省时回退
// 现有同步 JSON 读取，保持直连 createSettingsHandler 的调用兼容）；storage
// 为当前落盘模式（sqlite|json），无 store 时为 undefined。
function buildUsageReport(envDir, read, usageStore) {
    const config = read();
    const rawDays = usageStore
        ? usageStore.readRecentDays(30)
        : readRecentDays(defaultUsagePath(), 30);
    const days = rawDays.map((day) => {
        let cost = null;
        const models = Object.keys(day.byModel);
        if (models.length > 0) {
            cost = 0;
            for (const model of models) {
                const c = estimateCost(day.byModel[model], model, envDir);
                if (c === null) cost = null;
                else if (cost !== null) cost += c;
            }
        }
        return {
            date: day.date,
            requests: day.requests,
            inputTokens: day.inputTokens,
            outputTokens: day.outputTokens,
            cacheReadTokens: day.cacheReadTokens,
            cacheCreationTokens: day.cacheCreationTokens,
            totalTokens: day.inputTokens + day.outputTokens
                + day.cacheReadTokens + day.cacheCreationTokens,
            hitRate: cacheHitRate(day),
            cost,
            byModel: day.byModel
        };
    });
    const threshold = config.alerts.dailyTokens;
    const today = days[0] ?? { totalTokens: 0, cost: null };
    const dailyCost = config.alerts.dailyCost ?? 0;
    return {
        days,
        storage: usageStore?.mode,
        alert: {
            dailyTokens: threshold,
            dailyCost,
            ...computeUsageAlert({
                dailyTokens: threshold,
                dailyCost,
                todayTokens: today.totalTokens,
                todayCost: today.cost,
                thresholds: config.usageAlert
            })
        }
    };
}

// 导出 CSV：与 /api/usage 的 days 数组同源同值，cost 为 null（费用不可估）时输出空串。
function usageExportCsv(days) {
    const header = 'date,requests,inputTokens,outputTokens,'
        + 'cacheReadTokens,cacheCreationTokens,cost';
    // 字段含逗号/引号/换行时按 RFC 4180 加引号转义（当前 date 来源固定，
    // 转义为来源变更时的纵深防御）。
    const escapeCsv = (v) => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = days.map((day) => [
        day.date,
        day.requests,
        day.inputTokens,
        day.outputTokens,
        day.cacheReadTokens,
        day.cacheCreationTokens,
        day.cost === null ? '' : day.cost
    ].map(escapeCsv).join(','));
    return [header, ...lines].join('\n') + '\n';
}

async function handleSettingsApiRequest(
    context,
    req,
    res,
    url,
    host
) {
    if (url.pathname === '/api/captured-system-prompt') {
        if (req.method !== 'GET') {
            sendJson(
                res,
                405,
                { ok: false, error: '请求方法不支持' },
                { allow: 'GET' }
            );
            return;
        }
        const captured = createSystemPromptCapture({
            file: capturedSystemPromptPath()
        });
        sendJson(res, 200, {
            ok: true,
            data: { prompt: captured?.readCaptured() ?? null }
        });
        return;
    }
    if (url.pathname === '/api/usage') {
        if (req.method !== 'GET') {
            sendJson(
                res,
                405,
                { ok: false, error: '请求方法不支持' },
                { allow: 'GET' }
            );
            return;
        }
        sendJson(res, 200, {
            ok: true,
            data: buildUsageReport(context.envDir, context.read, context.usageStore)
        });
        return;
    }
    if (url.pathname === '/api/upstream-health') {
        if (req.method !== 'GET') {
            sendJson(
                res,
                405,
                { ok: false, error: '请求方法不支持' },
                { allow: 'GET' }
            );
            return;
        }
        // 与用量数据同口径：固定读全局 ~/.cc-proxy 落盘快照，只读不缓存，
        // 缺失/损坏由 readHealthSnapshot 回退空快照。
        sendJson(res, 200, {
            ok: true,
            data: readHealthSnapshot(defaultHealthPath())
        });
        return;
    }
    if (url.pathname === '/api/recent-requests') {
        if (req.method !== 'GET') {
            sendJson(
                res,
                405,
                { ok: false, error: '请求方法不支持' },
                { allow: 'GET' }
            );
            return;
        }
        // 只读最近请求落盘文件（与 upstream-health 同口径：不缓存，最多滞后
        // 防抖窗口 500ms）；缺失/损坏由 readRequestLog 回退空快照。
        sendJson(res, 200, {
            ok: true,
            data: readRequestLog(defaultRequestLogPath())
        });
        return;
    }
    if (url.pathname === '/api/usage/export') {
        if (req.method !== 'GET') {
            sendJson(
                res,
                405,
                { ok: false, error: '请求方法不支持' },
                { allow: 'GET' }
            );
            return;
        }
        const report = buildUsageReport(context.envDir, context.read, context.usageStore);
        if (url.searchParams.get('format') === 'csv') {
            const body = usageExportCsv(report.days);
            res.writeHead(200, commonHeaders({
                'content-type': 'text/csv; charset=utf-8',
                'content-disposition':
                    'attachment; filename="cc-proxy-usage.csv"',
                'content-length': Buffer.byteLength(body)
            }));
            res.end(body);
            return;
        }
        if (url.searchParams.get('format') === 'json') {
            sendJson(res, 200, {
                ok: true,
                data: report
            });
            return;
        }
        sendJson(res, 400, { ok: false, error: 'format 参数仅支持 csv 或 json' });
        return;
    }
    if (url.pathname !== '/api/settings') {
        sendJson(res, 404, {
            ok: false,
            error: 'Not found'
        });
        return;
    }
    if (req.method === 'GET') {
        sendJson(res, 200, {
            ok: true,
            data: publicSettings(await context.read())
        });
        return;
    }
    if (req.method !== 'PATCH') {
        sendJson(
            res,
            405,
            { ok: false, error: '请求方法不支持' },
            { allow: 'GET, PATCH' }
        );
        return;
    }
    await handleSettingsPatch(context, req, res, host);
}

async function handleSettingsRequest(context, req, res) {
    const expectedHost = context.expectedHost;
    const host = typeof expectedHost === 'function'
        ? expectedHost()
        : expectedHost;
    if (req.headers.host !== host) {
        sendJson(res, 403, {
            ok: false,
            error: '请求来源无效'
        });
        return;
    }

    const url = parseRequestUrl(req, res, host);
    if (!url || handlePageRequest(context, req, res, url)) return;
    if (url.pathname === '/api/bootstrap') {
        await handleBootstrapRequest(context, req, res, host);
        return;
    }
    if (!url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
    }
    if (!tokenMatches(
        req.headers['x-cc-proxy-token'],
        context.token
    )) {
        sendJson(res, 401, { ok: false, error: '未授权' });
        return;
    }
    if (url.pathname === '/api/session') {
        await handleSessionRequest(context, req, res, url);
        return;
    }
    await handleSettingsApiRequest(context, req, res, url, host);
}

export function openSettingsPage(url, {
    platform = process.platform,
    spawnProcess = spawn,
    output = process.stdout
} = {}) {
    let target;
    try {
        target = new URL(url);
    } catch {
        return false;
    }
    if (target.protocol !== 'http:'
        || target.hostname !== '127.0.0.1'
        || target.pathname !== '/'
        || target.search
        || target.hash
        || target.username
        || target.password) {
        return false;
    }

    try {
        if (typeof output.on === 'function') output.on('error', () => {});
        output.write(`[cc-proxy] settings: ${target.href}\n`);
    } catch {
        // Browser opening remains useful when terminal output is unavailable.
    }

    let command;
    let args;
    let options = { detached: true, stdio: 'ignore' };
    if (platform === 'win32') {
        command = 'rundll32.exe';
        args = ['url.dll,FileProtocolHandler', target.href];
        options = { ...options, windowsHide: true };
    } else if (platform === 'darwin') {
        command = 'open';
        args = [target.href];
    } else {
        command = 'xdg-open';
        args = [target.href];
    }

    let child;
    try {
        child = spawnProcess(command, args, options);
    } catch {
        return false;
    }
    try {
        if (typeof child?.on === 'function') child.on('error', () => {});
    } catch {
        // Synchronous listener failures must not stop the settings service.
    }
    try {
        if (typeof child?.unref === 'function') child.unref();
    } catch {
        // The detached child may still exit independently.
    }
    return true;
}

export function createSettingsHandler({
    createBootstrapNonce = () => randomBytes(32).toString('base64url'),
    bootstrapNonceTtlMs = BOOTSTRAP_NONCE_TTL_MS,
    maxBootstrapNonces = MAX_BOOTSTRAP_NONCES,
    now = Date.now,
    bodyTimeoutMs = BODY_TIMEOUT_MS,
    scheduleBodyTimeout = setTimeout,
    cancelBodyTimeout = clearTimeout,
    ...options
}) {
    if (!Number.isInteger(maxBootstrapNonces)
        || maxBootstrapNonces < 1) {
        throw new RangeError(
            'maxBootstrapNonces 必须是正整数'
        );
    }
    if (!Number.isInteger(bodyTimeoutMs)
        || bodyTimeoutMs < 1
        || bodyTimeoutMs > MAX_TIMER_MS) {
        throw new RangeError(
            `bodyTimeoutMs 必须是 1-${MAX_TIMER_MS} 的整数`
        );
    }
    const context = {
        ...options,
        createBootstrapNonce,
        bootstrapNonceTtlMs,
        maxBootstrapNonces,
        now,
        bodyTimeoutMs,
        scheduleBodyTimeout,
        cancelBodyTimeout,
        bootstrapNonces: new Map()
    };
    return async (req, res) => {
        try {
            await handleSettingsRequest(context, req, res);
        } catch {
            if (!res.headersSent) {
                sendJson(res, 500, { ok: false, error: '设置服务内部错误' });
            } else if (!res.writableEnded) {
                res.end();
            }
        }
    };
}

async function settleWithin(promise, timeoutMs) {
    let timer;
    try {
        await Promise.race([
            Promise.resolve(promise).catch(() => {}),
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export async function runSettingsWeb({
    envDir,
    createServer = http.createServer,
    createToken = () => randomBytes(32).toString('base64url'),
    createLifecycle = createSessionLifecycle,
    openPage = openSettingsPage,
    output = process.stdout,
    cleanupTimeoutMs = SESSION_TIMING.closeTimeoutMs + 100
} = {}) {
    const token = createToken();
    // 与代理运行时同一落盘层的用量存储（SQLite 优先，失败回退 JSON）：
    // /api/usage 与 /api/usage/export 经此读取，并透出 storage 模式标注。
    // 存储层初始化失败降级为 null：/api/usage 回退 JSON 读数，设置页整体
    // 仍可启动（token 已生成，不能因存储异常中断服务）。
    const usageStore = await createUsageStore().catch(() => null);
    let expectedHost = null;
    let lifecycle;
    let server;
    let rejectServerError;
    const serverError = new Promise((_, reject) => {
        rejectServerError = reject;
    });
    const serverErrorHandler = (error) => rejectServerError(error);
    const handler = createSettingsHandler({
        token,
        expectedHost: () => expectedHost,
        read: () => readConfig(envDir),
        write: (partial) => writeConfig(partial, envDir),
        envDir,
        usageStore,
        onSession: (req, res) => lifecycle.onSession(req, res)
    });
    server = createServer(handler);
    lifecycle = createLifecycle({ server });

    try {
        server.on('error', serverErrorHandler);
        const listening = new Promise((resolve, reject) => {
            try {
                server.listen(0, '127.0.0.1', resolve);
            } catch (error) {
                reject(error);
            }
        });
        await Promise.race([listening, serverError]);
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('设置服务监听地址无效');
        }
        expectedHost = `127.0.0.1:${address.port}`;
        openPage(`http://${expectedHost}/`, { output });
        await Promise.race([lifecycle.finished, serverError]);
    } catch (error) {
        try {
            lifecycle.close?.();
        } catch {
            // Preserve the original startup or runtime error.
        }
        await settleWithin(lifecycle.finished, cleanupTimeoutMs);
        throw error;
    } finally {
        server.off('error', serverErrorHandler);
    }
}
