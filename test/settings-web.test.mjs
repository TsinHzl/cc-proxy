import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import {
    createSessionLifecycle,
    createSettingsHandler,
    openSettingsPage,
    renderSettingsPage,
    runSettingsWeb,
    SESSION_TIMING
} from '../bin/settings-web.js';

test('page: renders dark settings page with exactly four switches', () => {
    const html = renderSettingsPage();
    const switches = html.match(/<input[^>]+type="checkbox"/g) ?? [];

    assert.match(html, /<title>cc-proxy 设置<\/title>/);
    assert.equal(switches.length, 4);
    assert.match(html, /id="forwardSuggestionMode"/);
    assert.match(html, /id="thinkingAsText"/);
    assert.match(html, /id="effortOverrideEnabled"/);
    assert.match(html, /id="effortOverrideLevel"/);
    assert.match(html, /id="systemPromptOverrideEnabled"/);
    assert.match(html, /id="systemPromptTemplate"/);
    assert.match(html, /id="systemPromptOverridePrompt"/);
    assert.match(html, /<option value="low">/);
    assert.match(html, /<option value="medium">/);
    assert.match(html, /<option value="high">/);
    assert.match(html, /<option value="xhigh">/);
    assert.match(html, /<option value="max">/);
    assert.match(html, /--page-bg:\s*#090a0c/);
    assert.match(html, /--card-bg:\s*#15171b/);
    assert.match(html, /--accent:\s*#2bbbad/);
});

test('page: explains suggestion forwarding and thinking text behavior', () => {
    const html = renderSettingsPage();

    assert.match(html, /Suggestion Mode 输入建议转发/);
    assert.match(html, /额外消耗 token/);
    assert.match(html, /思考内容文本化展示/);
    assert.match(html, /恢复 Claude Code 原生折叠 Thinking 块/);
    assert.match(html, /Effort 覆写/);
    assert.match(html, /无论 Claude Code 本地 effort 设置是什么/);
    assert.match(html, /系统提示词覆写/);
    assert.match(html, /为空时不生效/);
    assert.match(html, /内置工具与技能说明失效/);
    assert.match(html, /下次启动会话生效/);
});

test('page: contains no external resources or extra settings', () => {
    const html = renderSettingsPage();

    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    // 禁止外部资源引用；内联 data: URI（如 select 箭头 SVG）允许，先剥离再匹配
    assert.doesNotMatch(html.replace(/data:[^"]*/g, ''), /https?:\/\//i);
    assert.doesNotMatch(html, /账号选择|RPM|Admin Password|上游代理|语言切换/);
});

function createPageDeferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function pageJsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        json: async () => payload
    };
}

function extractInlineScript(html) {
    const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    assert.equal(matches.length, 1);
    return matches[0][1];
}

function createPageElement({ disabled = false } = {}) {
    const listeners = new Map();
    const classes = new Set();
    return {
        checked: false,
        disabled,
        value: '',
        textContent: '',
        classList: {
            toggle(name, force) {
                const enabled = force ?? !classes.has(name);
                if (enabled) classes.add(name);
                else classes.delete(name);
            },
            contains: (name) => classes.has(name)
        },
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        appendChild() {},
        async dispatch(type) {
            await listeners.get(type)?.({ type, target: this, currentTarget: this });
        }
    };
}

async function flushPageMicrotasks() {
    // 24 轮：覆盖 bootstrap → load → session → captured 预填的最长微任务链
    //（实测约 21 轮，留一倍余量）。
    for (let index = 0; index < 24; index += 1) {
        await Promise.resolve();
    }
}

function createPageHarness(fetchHandler) {
    const html = renderSettingsPage('vm-bootstrap');
    const inputTag = (id) => html.match(
        new RegExp(`<input[^>]+id="${id}"[^>]*>`, 'i')
    )?.[0] ?? '';
    const selectTag = (id) => html.match(
        new RegExp(`<select[^>]+id="${id}"[^>]*>`, 'i')
    )?.[0] ?? '';
    const elements = {
        forwardSuggestionMode: createPageElement({
            disabled: /\bdisabled\b/i.test(
                inputTag('forwardSuggestionMode')
            )
        }),
        thinkingAsText: createPageElement({
            disabled: /\bdisabled\b/i.test(inputTag('thinkingAsText'))
        }),
        effortOverrideEnabled: createPageElement({
            disabled: /\bdisabled\b/i.test(
                inputTag('effortOverrideEnabled')
            )
        }),
        effortOverrideLevel: createPageElement({
            disabled: /\bdisabled\b/i.test(
                selectTag('effortOverrideLevel')
            )
        }),
        systemPromptOverrideEnabled: createPageElement({
            disabled: /\bdisabled\b/i.test(
                inputTag('systemPromptOverrideEnabled')
            )
        }),
        systemPromptTemplate: createPageElement({
            disabled: /\bdisabled\b/i.test(
                selectTag('systemPromptTemplate')
            )
        }),
        systemPromptOverridePrompt: createPageElement({
            disabled: /\bdisabled\b/i.test(
                html.match(
                    /<textarea[^>]+id="systemPromptOverridePrompt"[^>]*>/i
                )?.[0] ?? ''
            )
        }),
        status: createPageElement()
    };
    const calls = [];
    class TestWritableStream {}
    const stores = new Map();
    const sessionStorage = {
        getItem: (key) => stores.get(key) ?? null,
        setItem: (key, value) => stores.set(key, String(value)),
        removeItem: (key) => stores.delete(key)
    };
    let reloadCount = 0;
    const vmContext = {
        document: {
            getElementById: (id) => elements[id],
            createElement: () => createPageElement()
        },
        fetch: async (url, options = {}) => {
            const call = { url, options };
            calls.push(call);
            return fetchHandler(call);
        },
        WritableStream: TestWritableStream,
        sessionStorage,
        location: {
            reload() {
                reloadCount += 1;
            }
        },
        createElement: () => createPageElement()
    };
    vm.runInNewContext(extractInlineScript(html), vmContext);
    return {
        calls,
        elements,
        sessionStorage,
        get reloadCount() {
            return reloadCount;
        },
        async change(key, checked) {
            elements[key].checked = checked;
            await elements[key].dispatch('change');
            await flushPageMicrotasks();
        }
    };
}

function pageSessionResponse() {
    const stream = createPageDeferred();
    const connected = createPageDeferred();
    return {
        ok: true,
        body: {
            pipeTo: () => {
                connected.resolve();
                return stream.promise;
            }
        },
        stream,
        connected: connected.promise
    };
}

test('page script: waits for bootstrap and initial load before enabling switches', async () => {
    const bootstrap = createPageDeferred();
    const settings = createPageDeferred();
    const page = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') return bootstrap.promise;
        if (url === '/api/settings') return settings.promise;
        if (url === '/api/session') return pageSessionResponse();
        throw new Error(`unexpected request: ${url}`);
    });

    assert.equal(page.elements.forwardSuggestionMode.disabled, true);
    assert.equal(page.elements.thinkingAsText.disabled, true);
    assert.deepEqual(page.calls.map(({ url }) => url), [
        '/api/bootstrap'
    ]);

    bootstrap.resolve(pageJsonResponse(200, {
        ok: true,
        data: { token: 'vm-token' }
    }));
    await flushPageMicrotasks();

    assert.deepEqual(page.calls.map(({ url }) => url), [
        '/api/bootstrap',
        '/api/settings',
        '/api/session'
    ]);
    assert.equal(page.elements.forwardSuggestionMode.disabled, true);
    assert.equal(page.elements.thinkingAsText.disabled, true);

    settings.resolve(pageJsonResponse(200, {
        ok: true,
        data: {
            forwardSuggestionMode: false,
            thinkingAsText: true,
            effortOverride: { enabled: true, level: 'high' }
        }
    }));
    await flushPageMicrotasks();

    assert.equal(page.elements.forwardSuggestionMode.checked, false);
    assert.equal(page.elements.thinkingAsText.checked, true);
    assert.equal(page.elements.effortOverrideEnabled.checked, true);
    assert.equal(page.elements.effortOverrideLevel.value, 'high');
    assert.equal(page.elements.forwardSuggestionMode.disabled, false);
    assert.equal(page.elements.thinkingAsText.disabled, false);
    assert.equal(page.elements.effortOverrideEnabled.disabled, false);
    assert.equal(page.elements.effortOverrideLevel.disabled, false);
});

test('page script: PATCH uses authoritative data and failed save can retry', async () => {
    const patchResponses = [];
    const page = createPageHarness(({ url, options }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, {
                ok: true,
                data: { token: 'vm-token' }
            });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (options.method === 'PATCH') {
            const response = createPageDeferred();
            patchResponses.push(response);
            return response.promise;
        }
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high' }
            }
        });
    });
    await flushPageMicrotasks();

    const firstSave = page.change('forwardSuggestionMode', true);
    assert.equal(page.elements.forwardSuggestionMode.disabled, true);
    assert.equal(page.elements.thinkingAsText.disabled, true);
    assert.equal(page.elements.effortOverrideEnabled.disabled, true);
    assert.equal(page.elements.effortOverrideLevel.disabled, true);
    patchResponses[0].resolve(pageJsonResponse(200, {
        ok: true,
        data: {
            forwardSuggestionMode: false,
            thinkingAsText: false,
            effortOverride: { enabled: true, level: 'high' }
        }
    }));
    await firstSave;
    assert.equal(page.elements.forwardSuggestionMode.checked, false);
    assert.equal(page.elements.thinkingAsText.checked, false);

    const failedSave = page.change('thinkingAsText', true);
    patchResponses[1].resolve(pageJsonResponse(500, {
        ok: false,
        error: '保存设置失败'
    }));
    await failedSave;
    assert.equal(page.elements.forwardSuggestionMode.checked, false);
    assert.equal(page.elements.thinkingAsText.checked, false);
    assert.equal(page.elements.thinkingAsText.disabled, false);
    assert.equal(page.elements.status.textContent, '保存失败');
    assert.equal(page.elements.status.classList.contains('error'), true);

    const retry = page.change('thinkingAsText', true);
    patchResponses[2].resolve(pageJsonResponse(200, {
        ok: true,
        data: {
            forwardSuggestionMode: true,
            thinkingAsText: true,
            effortOverride: { enabled: false, level: 'low' }
        }
    }));
    await retry;
    assert.equal(page.elements.forwardSuggestionMode.checked, true);
    assert.equal(page.elements.thinkingAsText.checked, true);
    assert.equal(page.elements.effortOverrideEnabled.checked, false);
    assert.equal(page.elements.effortOverrideLevel.value, 'low');
});

test('page script: bootstrap failure reloads once then errors on retry', async (t) => {
    await t.test('first failure reloads page once for a fresh nonce', async () => {
        const page = createPageHarness(() => pageJsonResponse(401, {
            ok: false,
            error: '未授权'
        }));
        await flushPageMicrotasks();

        assert.equal(page.reloadCount, 1);
        assert.equal(page.sessionStorage.getItem('bootstrap-retried'), '1');
        assert.equal(page.elements.forwardSuggestionMode.disabled, true);
        assert.equal(page.elements.thinkingAsText.disabled, true);
        assert.equal(page.elements.status.textContent, '');
    });

    await t.test('failure after retry shows auth error', async () => {
        const page = createPageHarness(() => pageJsonResponse(401, {
            ok: false,
            error: '未授权'
        }));
        page.sessionStorage.setItem('bootstrap-retried', '1');
        await flushPageMicrotasks();

        assert.equal(page.reloadCount, 0);
        assert.equal(page.elements.forwardSuggestionMode.disabled, true);
        assert.equal(page.elements.thinkingAsText.disabled, true);
        assert.equal(
            page.elements.status.textContent,
            '页面认证失败，请重新打开设置页'
        );
    });

    await t.test('initial load', async () => {
        const page = createPageHarness(({ url }) => {
            if (url === '/api/bootstrap') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { token: 'vm-token' }
                });
            }
            if (url === '/api/session') return pageSessionResponse();
            return pageJsonResponse(500, {
                ok: false,
                error: '读取失败'
            });
        });
        await flushPageMicrotasks();

        assert.equal(page.elements.forwardSuggestionMode.disabled, true);
        assert.equal(page.elements.thinkingAsText.disabled, true);
        assert.equal(page.elements.status.textContent, '读取设置失败');
    });
});

test('page script: session failure or disconnect keeps switches disabled', async (t) => {
    await t.test('session fails before settings succeeds', async () => {
        const settings = createPageDeferred();
        const page = createPageHarness(({ url }) => {
            if (url === '/api/bootstrap') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { token: 'vm-token' }
                });
            }
            if (url === '/api/settings') return settings.promise;
            return pageJsonResponse(500, {
                ok: false,
                error: '连接失败'
            });
        });
        await flushPageMicrotasks();

        settings.resolve(pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high' }
            }
        }));
        await flushPageMicrotasks();

        assert.equal(page.elements.forwardSuggestionMode.disabled, true);
        assert.equal(page.elements.thinkingAsText.disabled, true);
        assert.equal(page.elements.effortOverrideEnabled.disabled, true);
        assert.equal(page.elements.effortOverrideLevel.disabled, true);
        assert.equal(page.elements.status.textContent, '设置页面连接失败');
    });

    await t.test('session fails after settings succeeds', async () => {
        const session = createPageDeferred();
        const page = createPageHarness(({ url }) => {
            if (url === '/api/bootstrap') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { token: 'vm-token' }
                });
            }
            if (url === '/api/session') return session.promise;
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: true, level: 'high' }
                }
            });
        });
        await flushPageMicrotasks();

        assert.equal(page.elements.forwardSuggestionMode.disabled, true);
        session.resolve(pageJsonResponse(500, {
            ok: false,
            error: '连接失败'
        }));
        await flushPageMicrotasks();

        assert.equal(page.elements.forwardSuggestionMode.disabled, true);
        assert.equal(page.elements.thinkingAsText.disabled, true);
    });

    await t.test('session disconnects after initialization', async () => {
        const session = pageSessionResponse();
        const page = createPageHarness(({ url }) => {
            if (url === '/api/bootstrap') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { token: 'vm-token' }
                });
            }
            if (url === '/api/session') return session;
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: true, level: 'high' }
                }
            });
        });
        await session.connected;

        assert.equal(page.elements.forwardSuggestionMode.disabled, false);
        assert.equal(page.elements.thinkingAsText.disabled, false);

        session.stream.resolve();
        await flushPageMicrotasks();

        assert.equal(page.elements.forwardSuggestionMode.disabled, true);
        assert.equal(page.elements.thinkingAsText.disabled, true);
        assert.equal(
            page.elements.status.textContent,
            '设置页面连接已断开'
        );
    });
});

test('page script: prefills captured prompt on load when textarea is empty', async (t) => {
    await t.test('fills captured prompt regardless of switch state', async () => {
        const page = createPageHarness(({ url }) => {
            if (url === '/api/bootstrap') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { token: 'vm-token' }
                });
            }
            if (url === '/api/captured-system-prompt') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { prompt: 'CC 默认系统提示词' }
                });
            }
            if (url === '/api/session') return pageSessionResponse();
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: true, level: 'high' },
                    systemPromptOverride: { enabled: false, prompt: '' }
                }
            });
        });
        await flushPageMicrotasks();

        // 开关关闭态下输入框仍展示捕获的 CC 默认提示词。
        assert.equal(page.elements.systemPromptOverridePrompt.value, 'CC 默认系统提示词');
        assert.equal(page.elements.systemPromptOverrideEnabled.checked, false);
        // 加载路径无 PATCH 调用（仅展示，不提交）。
        assert.equal(
            page.calls.filter(({ options }) => options.method === 'PATCH').length,
            0
        );
    });

    await t.test('keeps empty when no captured data', async () => {
        const page = createPageHarness(({ url }) => {
            if (url === '/api/bootstrap') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { token: 'vm-token' }
                });
            }
            if (url === '/api/captured-system-prompt') {
                return pageJsonResponse(200, { ok: true, data: { prompt: null } });
            }
            if (url === '/api/session') return pageSessionResponse();
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: true, level: 'high' },
                    systemPromptOverride: { enabled: false, prompt: '' }
                }
            });
        });
        await flushPageMicrotasks();

        assert.equal(page.elements.systemPromptOverridePrompt.value, '');
    });

    await t.test('does not overwrite user input typed during prefill', async () => {
        // captured 响应挂起：用户在预填拉取期间输入，填入不得覆盖用户内容。
        const captured = createPageDeferred();
        const page = createPageHarness(({ url }) => {
            if (url === '/api/bootstrap') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { token: 'vm-token' }
                });
            }
            if (url === '/api/captured-system-prompt') return captured.promise;
            if (url === '/api/session') return pageSessionResponse();
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: true, level: 'high' },
                    systemPromptOverride: { enabled: false, prompt: '' }
                }
            });
        });
        await flushPageMicrotasks();
        // 预填拉取已在飞：模拟用户输入后捕获响应才返回。
        page.elements.systemPromptOverridePrompt.value = '用户自己的内容';
        captured.resolve(pageJsonResponse(200, {
            ok: true,
            data: { prompt: 'CC 默认系统提示词' }
        }));
        await flushPageMicrotasks();

        assert.equal(page.elements.systemPromptOverridePrompt.value, '用户自己的内容');
    });

    await t.test('prefill failure does not block initialization', async () => {
        const page = createPageHarness(({ url }) => {
            if (url === '/api/bootstrap') {
                return pageJsonResponse(200, {
                    ok: true,
                    data: { token: 'vm-token' }
                });
            }
            if (url === '/api/captured-system-prompt') {
                return pageJsonResponse(500, { ok: false, error: '读取失败' });
            }
            if (url === '/api/session') return pageSessionResponse();
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: true, level: 'high' },
                    systemPromptOverride: { enabled: false, prompt: '' }
                }
            });
        });
        await flushPageMicrotasks();

        // 页面照常可用（控件已启用），输入框保持为空。
        assert.equal(page.elements.forwardSuggestionMode.disabled, false);
        assert.equal(page.elements.systemPromptOverridePrompt.disabled, false);
        assert.equal(page.elements.systemPromptOverridePrompt.value, '');
    });
});

async function startApi({
    read,
    write,
    createBootstrapNonce,
    bootstrapNonceTtlMs,
    maxBootstrapNonces,
    now
}) {
    const token = 'test-token-123';
    const server = http.createServer(createSettingsHandler({
        token,
        expectedHost: () => `127.0.0.1:${server.address().port}`,
        read,
        write,
        createBootstrapNonce,
        bootstrapNonceTtlMs,
        maxBootstrapNonces,
        now
    }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        server,
        token,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

function authHeaders(api, extra = {}) {
    return { 'X-CC-Proxy-Token': api.token, ...extra };
}

function padJsonToBytes(value, expectedBytes) {
    const json = JSON.stringify(value);
    const paddingBytes = expectedBytes - Buffer.byteLength(json);
    assert.ok(paddingBytes >= 0);
    const body = `${json}${' '.repeat(paddingBytes)}`;
    assert.equal(Buffer.byteLength(body), expectedBytes);
    return body;
}

function flushAsyncTurn() {
    return new Promise((resolve) => setImmediate(resolve));
}

function createManualBodyTimers() {
    let nextId = 0;
    const active = new Map();
    const scheduled = [];
    const cleared = [];
    return {
        schedule: (callback, delay) => {
            const id = ++nextId;
            active.set(id, callback);
            scheduled.push({ id, delay });
            return id;
        },
        cancel: (id) => {
            cleared.push(id);
            active.delete(id);
        },
        fire: (id) => {
            const callback = active.get(id);
            assert.ok(callback, `timer ${id} is not active`);
            active.delete(id);
            callback();
        },
        get scheduled() { return [...scheduled]; },
        get cleared() { return [...cleared]; },
        get pendingCount() { return active.size; }
    };
}

function createBodyRequest({ contentLength } = {}) {
    const req = new EventEmitter();
    req.method = 'PATCH';
    req.url = '/api/settings';
    req.headers = {
        host: 'settings.test',
        origin: 'http://settings.test',
        'content-type': 'application/json',
        'x-cc-proxy-token': 'test-token'
    };
    if (contentLength !== undefined) {
        req.headers['content-length'] = String(contentLength);
    }
    req.resumeCalls = 0;
    req.destroyCalls = 0;
    req.resume = () => {
        req.resumeCalls += 1;
        return req;
    };
    req.destroy = () => {
        req.destroyCalls += 1;
        req.destroyed = true;
    };
    return req;
}

function createJsonResponseRecorder() {
    const res = new EventEmitter();
    const chunks = [];
    const callbacks = [];
    res.headersSent = false;
    res.writableEnded = false;
    res.writableFinished = false;
    res.endCalls = 0;
    res.writeHead = (statusCode, headers) => {
        res.statusCode = statusCode;
        res.headers = headers;
        res.headersSent = true;
    };
    res.end = (chunk, encoding, callback) => {
        if (typeof encoding === 'function') callback = encoding;
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        if (callback) callbacks.push(callback);
        res.endCalls += 1;
        res.writableEnded = true;
    };
    res.flush = () => {
        res.writableFinished = true;
        res.emit('finish');
        for (const callback of callbacks.splice(0)) callback();
    };
    res.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return res;
}

function createBodyHandler({
    timers,
    bodyTimeoutMs = 37,
    read = () => ({
        forwardSuggestionMode: false,
        thinkingAsText: true
    }),
    write = () => ({
        forwardSuggestionMode: false,
        thinkingAsText: false
    })
} = {}) {
    return createSettingsHandler({
        token: 'test-token',
        expectedHost: 'settings.test',
        read,
        write,
        bodyTimeoutMs,
        scheduleBodyTimeout: timers?.schedule,
        cancelBodyTimeout: timers?.cancel
    });
}

function extractBootstrapNonce(html) {
    // 注入的是 JSON 字面量（渲染结果如 "nonce"），解析即得原始值。
    const match = html.match(/const bootstrapNonce = (?<json>"(?:[^"\\]|\\.)*");/);
    assert.ok(match, 'settings page must contain a bootstrap nonce');
    return JSON.parse(match.groups.json);
}

async function requestBootstrap(origin, nonce, requestOrigin = origin) {
    return fetch(`${origin}/api/bootstrap`, {
        method: 'POST',
        headers: {
            Origin: requestOrigin,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ nonce })
    });
}

function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout])
        .finally(() => clearTimeout(timer));
}

async function waitUntil(targetTime) {
    const remaining = targetTime - performance.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => {
        setTimeout(resolve, Math.ceil(remaining));
    });
}

async function bootstrapFromPage(origin) {
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    const nonce = extractBootstrapNonce(await page.text());
    const response = await requestBootstrap(origin, nonce);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.data.token, 'string');
    assert.ok(payload.data.token.length > 0);
    return payload.data.token;
}

function openSseLease(origin, token) {
    return new Promise((resolve, reject) => {
        let response;
        let timer;
        let settled = false;
        let leaseClosed = false;
        const leaseClosedSignal = createPageDeferred();
        let request;

        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            response?.destroy();
            request?.destroy();
            reject(error);
        };

        request = http.get(`${origin}/api/session`, {
            agent: false,
            headers: {
                'X-CC-Proxy-Token': token
            }
        });
        request.once('error', fail);
        request.once('response', (incoming) => {
            response = incoming;
            response.once('close', () => {
                leaseClosed = true;
                leaseClosedSignal.resolve();
                fail(new Error(
                    'SSE closed before connected marker'
                ));
            });
            response.once('end', () => {
                fail(new Error(
                    'SSE ended before connected marker'
                ));
            });
            if (response.statusCode !== 200) {
                response.resume();
                fail(new Error(
                    `unexpected SSE status: ${response.statusCode}`
                ));
                return;
            }

            let received = '';
            response.setEncoding('utf8');
            response.once('error', fail);
            response.once('aborted', () => {
                fail(new Error(
                    'SSE aborted before connected marker'
                ));
            });
            response.on('data', (chunk) => {
                received += chunk;
                if (settled
                    || !received.includes(': connected\n\n')) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                let closeRequested = false;
                resolve({
                    connectedAt: performance.now(),
                    isClosed: () => leaseClosed,
                    closed: leaseClosedSignal.promise,
                    async close() {
                        if (!closeRequested) {
                            closeRequested = true;
                            response.destroy();
                            request.destroy();
                        }
                        await withTimeout(
                            leaseClosedSignal.promise,
                            2_000,
                            'SSE lease did not close'
                        );
                    }
                });
            });
        });
        timer = setTimeout(() => {
            fail(new Error(
                'SSE did not emit connected marker'
            ));
        }, 2_000);
    });
}

function createObservedLifecycleHarness() {
    let lifecycle;
    let server;
    const leaseClosures = [];
    return {
        createLifecycle(options) {
            server = options.server;
            lifecycle = createSessionLifecycle(options);
            return {
                ...lifecycle,
                onSession(req, res) {
                    const closed = createPageDeferred();
                    const lease = {
                        closed: false,
                        promise: closed.promise
                    };
                    const result = lifecycle.onSession(req, res);
                    res.once('close', () => {
                        lease.closed = true;
                        closed.resolve(performance.now());
                    });
                    leaseClosures.push(lease);
                    return result;
                }
            };
        },
        waitForLeaseClose(index) {
            assert.ok(
                leaseClosures[index],
                `lease ${index} must have been opened`
            );
            return withTimeout(
                leaseClosures[index].promise,
                2_000,
                `lease ${index} did not close`
            );
        },
        isLeaseClosed(index) {
            assert.ok(
                leaseClosures[index],
                `lease ${index} must have been opened`
            );
            return leaseClosures[index].closed;
        },
        close() {
            lifecycle?.close();
        },
        forceCloseConnections() {
            server?.closeAllConnections?.();
        }
    };
}

function getSettingsOverNewConnection(origin, token) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        const request = http.get(`${origin}/api/settings`, {
            agent: false,
            headers: {
                'X-CC-Proxy-Token': token
            }
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.once('error', (error) => {
                finish(reject, error);
            });
            response.once('aborted', () => {
                finish(reject, new Error(
                    'settings probe aborted'
                ));
            });
            response.once('end', () => {
                try {
                    finish(resolve, {
                        statusCode: response.statusCode,
                        data: JSON.parse(
                            Buffer.concat(chunks).toString('utf8')
                        )
                    });
                } catch (error) {
                    finish(reject, error);
                }
            });
        });
        request.once('error', (error) => {
            finish(reject, error);
        });
        timer = setTimeout(() => {
            request.destroy();
            finish(reject, new Error(
                'settings probe timed out'
            ));
        }, 2_000);
    });
}

async function assertPortCanRebind(port) {
    const probe = http.createServer();
    try {
        await new Promise((resolve, reject) => {
            probe.once('error', reject);
            probe.listen(port, '127.0.0.1', resolve);
        });
        assert.equal(probe.address().port, port);
    } finally {
        if (probe.listening) {
            await new Promise((resolve) => probe.close(resolve));
        }
    }
}

test(
    'integration: real HTTP/SSE survives reconnect and releases port',
    { timeout: 15_000 },
    async (t) => {
        const envDir = fs.mkdtempSync(path.join(
            os.tmpdir(),
            'cc-proxy-settings-web-'
        ));
        const opened = createPageDeferred();
        const harness = createObservedLifecycleHarness();
        const leases = new Set();
        let completion;

        t.after(async () => {
            await Promise.allSettled(
                [...leases].map((lease) => lease.close())
            );
            harness.close();
            if (completion) {
                try {
                    await withTimeout(
                        completion,
                        SESSION_TIMING.closeTimeoutMs + 1_500,
                        'settings service cleanup timed out'
                    );
                } catch {
                    harness.forceCloseConnections();
                    await withTimeout(
                        completion,
                        1_000,
                        'forced cleanup timed out'
                    ).catch(() => {});
                }
            }
            fs.rmSync(envDir, { recursive: true, force: true });
        });

        completion = runSettingsWeb({
            envDir,
            createLifecycle: harness.createLifecycle,
            openPage: (url) => opened.resolve(url),
            output: { write() {} }
        }).then(
            () => ({ error: null }),
            (error) => ({ error })
        );

        const baseUrl = await withTimeout(
            opened.promise,
            2_000,
            'settings service did not open'
        );
        const origin = new URL(baseUrl).origin;
        const port = Number(new URL(baseUrl).port);
        const token = await bootstrapFromPage(origin);

        const initial = await fetch(`${origin}/api/settings`, {
            headers: { 'X-CC-Proxy-Token': token }
        });
        assert.equal(initial.status, 200);
        assert.deepEqual((await initial.json()).data, {
            forwardSuggestionMode: false,
            thinkingAsText: true,
            effortOverride: { enabled: true, level: 'high' },
            systemPromptOverride: { enabled: false, prompt: '' }
        });

        const updated = await fetch(`${origin}/api/settings`, {
            method: 'PATCH',
            headers: {
                'X-CC-Proxy-Token': token,
                Origin: origin,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                key: 'forwardSuggestionMode',
                value: true
            })
        });
        assert.equal(updated.status, 200);
        assert.deepEqual((await updated.json()).data, {
            forwardSuggestionMode: true,
            thinkingAsText: true,
            effortOverride: { enabled: true, level: 'high' },
            systemPromptOverride: { enabled: false, prompt: '' }
        });

        const configFile = path.join(envDir, 'config.json');
        assert.deepEqual(
            JSON.parse(fs.readFileSync(configFile, 'utf8')),
            {
                thinkingWindow: { enabled: false, lines: 10 },
                forwardSuggestionMode: true,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high' },
                systemPromptOverride: { enabled: false, prompt: '' }
            }
        );
        assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

        const first = await openSseLease(origin, token);
        const second = await openSseLease(origin, token);
        leases.add(first);
        leases.add(second);

        await first.close();
        await harness.waitForLeaseClose(0);
        await flushAsyncTurn();
        assert.equal(second.isClosed(), false);
        assert.equal(harness.isLeaseClosed(1), false);
        const whileSecondOpen = await getSettingsOverNewConnection(
            origin,
            token
        );
        assert.equal(whileSecondOpen.statusCode, 200);
        assert.equal(whileSecondOpen.data.ok, true);

        await second.close();
        const lastClosedAt = await harness.waitForLeaseClose(1);
        const reconnected = await openSseLease(origin, token);
        leases.add(reconnected);
        assert.ok(
            reconnected.connectedAt - lastClosedAt
                < SESSION_TIMING.disconnectGraceMs
        );

        await waitUntil(
            lastClosedAt
                + SESSION_TIMING.disconnectGraceMs
                + 100
        );
        assert.equal(reconnected.isClosed(), false);
        assert.equal(harness.isLeaseClosed(2), false);
        const afterOriginalDeadline =
            await getSettingsOverNewConnection(origin, token);
        assert.equal(afterOriginalDeadline.statusCode, 200);
        assert.equal(afterOriginalDeadline.data.ok, true);

        await reconnected.close();
        await harness.waitForLeaseClose(2);
        const result = await withTimeout(
            completion,
            SESSION_TIMING.disconnectGraceMs
                + SESSION_TIMING.closeTimeoutMs
                + 2_000,
            'settings service did not finish'
        );
        assert.ifError(result.error);
        await assertPortCanRebind(port);
    }
);

test('bootstrap: nonce is per-page, wrong Origin does not consume it, and replay is rejected', async (t) => {
    let nonceSequence = 0;
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run'),
        createBootstrapNonce: () => `bootstrap-${nonceSequence += 1}`
    });
    t.after(api.close);

    const firstPage = await fetch(`${api.origin}/`).then((response) => response.text());
    const secondPage = await fetch(`${api.origin}/`).then((response) => response.text());
    const firstNonce = extractBootstrapNonce(firstPage);
    const secondNonce = extractBootstrapNonce(secondPage);
    assert.notEqual(firstNonce, secondNonce);

    const wrongOrigin = await requestBootstrap(
        api.origin,
        firstNonce,
        'https://evil.example'
    );
    assert.equal(wrongOrigin.status, 403);

    const accepted = await requestBootstrap(api.origin, firstNonce);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
        ok: true,
        data: { token: api.token }
    });

    const replay = await requestBootstrap(api.origin, firstNonce);
    assert.equal(replay.status, 401);

    const secondAccepted = await requestBootstrap(api.origin, secondNonce);
    assert.equal(secondAccepted.status, 200);
});

test('bootstrap: nonce expires exactly at its TTL boundary', async (t) => {
    let currentTime = 0;
    let nonceSequence = 0;
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run'),
        createBootstrapNonce: () => `ttl-${nonceSequence += 1}`,
        bootstrapNonceTtlMs: 30_000,
        now: () => currentTime
    });
    t.after(api.close);

    const beforeBoundaryPage = await fetch(`${api.origin}/`);
    const beforeBoundaryNonce = extractBootstrapNonce(
        await beforeBoundaryPage.text()
    );
    currentTime = 29_999;
    const beforeBoundary = await requestBootstrap(
        api.origin,
        beforeBoundaryNonce
    );
    assert.equal(beforeBoundary.status, 200);

    currentTime = 30_000;
    const boundaryPage = await fetch(`${api.origin}/`);
    const boundaryNonce = extractBootstrapNonce(await boundaryPage.text());
    currentTime = 60_000;
    const atBoundary = await requestBootstrap(api.origin, boundaryNonce);
    assert.equal(atBoundary.status, 401);
});

test('bootstrap: pending nonce capacity evicts the oldest entry', async (t) => {
    let nonceSequence = 0;
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run'),
        createBootstrapNonce: () => `capacity-${nonceSequence += 1}`,
        maxBootstrapNonces: 2
    });
    t.after(api.close);

    const nonces = [];
    for (let index = 0; index < 3; index += 1) {
        const page = await fetch(`${api.origin}/`);
        nonces.push(extractBootstrapNonce(await page.text()));
    }

    const evicted = await requestBootstrap(api.origin, nonces[0]);
    assert.equal(evicted.status, 401);

    for (const nonce of nonces.slice(1)) {
        const accepted = await requestBootstrap(api.origin, nonce);
        assert.equal(accepted.status, 200);
    }
});

test('bootstrap: rejects invalid pending nonce capacities', () => {
    for (const maxBootstrapNonces of [0, -1, 1.5, NaN, Infinity]) {
        assert.throws(
            () => createSettingsHandler({ maxBootstrapNonces }),
            /maxBootstrapNonces/
        );
    }
});

test('API: reads only public settings with valid token', async (t) => {
    const api = await startApi({
        read: () => ({
            thinkingWindow: { enabled: false, lines: 10 },
            forwardSuggestionMode: false,
            thinkingAsText: true
        }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    const response = await fetch(`${api.origin}/api/settings`, { headers: authHeaders(api) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        ok: true,
        data: { forwardSuggestionMode: false, thinkingAsText: true }
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-type'), /^application\/json/);
});

test('API: PATCH writes one boolean setting', async (t) => {
    let update = null;
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: (partial) => {
            update = partial;
            return { forwardSuggestionMode: true, thinkingAsText: true };
        }
    });
    t.after(api.close);

    const response = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, {
            Origin: api.origin,
            'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ key: 'forwardSuggestionMode', value: true })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(update, { forwardSuggestionMode: true });
    assert.deepEqual(await response.json(), {
        ok: true,
        data: { forwardSuggestionMode: true, thinkingAsText: true }
    });
});

test('API: PATCH effortOverride.enabled merges nested partial', async (t) => {
    let update = null;
    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            effortOverride: { enabled: true, level: 'high' }
        }),
        write: (partial) => {
            update = partial;
            return {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: false, level: 'high' }
            };
        }
    });
    t.after(api.close);

    const response = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, {
            Origin: api.origin,
            'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ key: 'effortOverride.enabled', value: false })
    });
    assert.equal(response.status, 200);
    // 点号 key 展开为嵌套 partial，writeConfig 逐字段合并保留 level。
    assert.deepEqual(update, { effortOverride: { enabled: false } });
    assert.deepEqual(await response.json(), {
        ok: true,
        data: {
            forwardSuggestionMode: false,
            thinkingAsText: true,
            effortOverride: { enabled: false, level: 'high' }
        }
    });
});

test('API: PATCH effortOverride.level writes level and keeps enabled', async (t) => {
    let update = null;
    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            effortOverride: { enabled: false, level: 'high' }
        }),
        write: (partial) => {
            update = partial;
            return {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: false, level: 'medium' }
            };
        }
    });
    t.after(api.close);

    const response = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, {
            Origin: api.origin,
            'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ key: 'effortOverride.level', value: 'medium' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(update, { effortOverride: { level: 'medium' } });

    // 新增档位 xhigh / max / ultracode 同样接受 PATCH。
    for (const level of ['xhigh', 'max', 'ultracode']) {
        const res = await fetch(`${api.origin}/api/settings`, {
            method: 'PATCH',
            headers: authHeaders(api, {
                Origin: api.origin,
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify({ key: 'effortOverride.level', value: level })
        });
        assert.equal(res.status, 200, `level=${level}`);
        assert.deepEqual(update, { effortOverride: { level } });
    }

    assert.deepEqual((await response.json()).data.effortOverride, {
        enabled: false,
        level: 'medium'
    });
});

test('API: rejects invalid effortOverride patches without writes', async (t) => {
    let writes = 0;
    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            effortOverride: { enabled: true, level: 'high' }
        }),
        write: () => { writes += 1; }
    });
    t.after(api.close);

    for (const body of [
        // level 非法档位（含大小写敏感）与非字符串值。
        JSON.stringify({ key: 'effortOverride.level', value: 'extreme' }),
        JSON.stringify({ key: 'effortOverride.level', value: 'HIGH' }),
        JSON.stringify({ key: 'effortOverride.level', value: 2 }),
        JSON.stringify({ key: 'effortOverride.level', value: null }),
        // enabled 非布尔值。
        JSON.stringify({ key: 'effortOverride.enabled', value: 'false' }),
        JSON.stringify({ key: 'effortOverride.enabled', value: 1 })
    ]) {
        const response = await fetch(`${api.origin}/api/settings`, {
            method: 'PATCH',
            headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
            body
        });
        assert.equal(response.status, 400, body);
    }
    assert.equal(writes, 0);
});

test('API: PATCH systemPromptOverride writes prompt and enabled', async (t) => {
    let update = null;
    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            systemPromptOverride: { enabled: false, prompt: '' }
        }),
        write: (partial) => {
            update = partial;
            return {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                systemPromptOverride: { enabled: false, prompt: '自定义提示词' }
            };
        }
    });
    t.after(api.close);

    const promptPatch = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'systemPromptOverride.prompt', value: '自定义提示词' })
    });
    assert.equal(promptPatch.status, 200);
    assert.deepEqual(update, { systemPromptOverride: { prompt: '自定义提示词' } });
    assert.deepEqual((await promptPatch.json()).data.systemPromptOverride, {
        enabled: false,
        prompt: '自定义提示词'
    });

    const enabledPatch = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'systemPromptOverride.enabled', value: true })
    });
    assert.equal(enabledPatch.status, 200);
    assert.deepEqual(update, { systemPromptOverride: { enabled: true } });
});

test('API: rejects invalid systemPromptOverride patches without writes', async (t) => {
    let writes = 0;
    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            systemPromptOverride: { enabled: false, prompt: '' }
        }),
        write: () => { writes += 1; }
    });
    t.after(api.close);

    for (const body of [
        // prompt 非字符串与超 256KB（UTF-8 字节；90000 个汉字 = 270000 字节，
        // 高于 prompt 校验上限且低于 320KB 正文上限，确保走 400 校验拒绝路径）。
        JSON.stringify({ key: 'systemPromptOverride.prompt', value: 42 }),
        JSON.stringify({ key: 'systemPromptOverride.prompt', value: null }),
        JSON.stringify({ key: 'systemPromptOverride.prompt', value: '中'.repeat(90000) }),
        // enabled 非布尔值。
        JSON.stringify({ key: 'systemPromptOverride.enabled', value: 'true' }),
        JSON.stringify({ key: 'systemPromptOverride.enabled', value: 1 })
    ]) {
        const response = await fetch(`${api.origin}/api/settings`, {
            method: 'PATCH',
            headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
            body
        });
        assert.equal(response.status, 400, body);
    }
    assert.equal(writes, 0);
});

test('API: GET captured-system-prompt returns captured text or null', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-captured-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const capturedFile = path.join(home, '.cc-proxy', 'captured-system-prompt.json');
    fs.mkdirSync(path.dirname(capturedFile), { recursive: true });
    fs.writeFileSync(capturedFile, JSON.stringify({ prompt: 'You are Claude Code.' }));
    const realHomedir = os.homedir;
    os.homedir = () => home;
    t.after(() => { os.homedir = realHomedir; });

    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    const captured = await fetch(`${api.origin}/api/captured-system-prompt`, {
        headers: authHeaders(api)
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(await captured.json(), {
        ok: true,
        data: { prompt: 'You are Claude Code.' }
    });

    // 未捕获（文件缺失）时 prompt 为 null。
    fs.rmSync(capturedFile, { force: true });
    const missing = await fetch(`${api.origin}/api/captured-system-prompt`, {
        headers: authHeaders(api)
    });
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), { ok: true, data: { prompt: null } });
});

test('API: captured-system-prompt rejects invalid token and non-GET', async (t) => {
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    const unauthorized = await fetch(`${api.origin}/api/captured-system-prompt`);
    assert.equal(unauthorized.status, 401);

    const post = await fetch(`${api.origin}/api/captured-system-prompt`, {
        method: 'POST',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: '{}'
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
});

test('API: rejects invalid token, Host and Origin without writes', async (t) => {
    let writes = 0;
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => { writes += 1; }
    });
    t.after(api.close);

    const badToken = await fetch(`${api.origin}/api/settings`, {
        headers: { 'X-CC-Proxy-Token': 'wrong' }
    });
    assert.equal(badToken.status, 401);

    const badHost = await new Promise((resolve, reject) => {
        const req = http.request(`${api.origin}/api/settings`, {
            headers: { Host: 'evil.example', 'X-CC-Proxy-Token': api.token }
        }, resolve);
        req.on('error', reject);
        req.end();
    });
    assert.equal(badHost.statusCode, 403);
    badHost.resume();

    const badOrigin = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: 'https://evil.example', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'thinkingAsText', value: false })
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(writes, 0);
});

test('API: rejects method, content-type, oversized and invalid bodies', async (t) => {
    let writes = 0;
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => { writes += 1; }
    });
    t.after(api.close);

    const post = await fetch(`${api.origin}/api/settings`, {
        method: 'POST',
        headers: authHeaders(api)
    });
    assert.equal(post.status, 405);

    for (const contentType of ['text/plain', 'application/jsonp', 'application/json-invalid']) {
        const wrongType = await fetch(`${api.origin}/api/settings`, {
            method: 'PATCH',
            headers: authHeaders(api, { Origin: api.origin, 'Content-Type': contentType }),
            body: '{}'
        });
        assert.equal(wrongType.status, 415);
        assert.deepEqual(await wrongType.json(), { ok: false, error: '仅支持 JSON' });
    }

    const oversized = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'thinkingAsText', value: false, padding: 'x'.repeat(327_681) })
    });
    assert.equal(oversized.status, 413);

    for (const body of [
        '{bad',
        JSON.stringify({ key: 'unknown', value: true }),
        JSON.stringify({ key: 'thinkingAsText', value: 'false' }),
        JSON.stringify({ key: 'thinkingAsText', value: false, extra: true })
    ]) {
        const response = await fetch(`${api.origin}/api/settings`, {
            method: 'PATCH',
            headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
            body
        });
        assert.equal(response.status, 400);
    }
    assert.equal(writes, 0);
});

test('API: write failure returns 500 and server remains usable', async (t) => {
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: async () => { throw new Error('disk full'); }
    });
    t.after(api.close);

    const failed = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'thinkingAsText', value: false })
    });
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { ok: false, error: '保存设置失败' });

    const healthy = await fetch(`${api.origin}/api/settings`, { headers: authHeaders(api) });
    assert.equal(healthy.status, 200);
});

test('API: read failure returns 500 and server remains usable', async (t) => {
    let shouldFail = true;
    const api = await startApi({
        read: async () => {
            if (shouldFail) throw new Error('read failed');
            return { forwardSuggestionMode: false, thinkingAsText: true };
        },
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    const failed = await fetch(`${api.origin}/api/settings`, { headers: authHeaders(api) });
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { ok: false, error: '设置服务内部错误' });

    shouldFail = false;
    const healthy = await fetch(`${api.origin}/api/settings`, { headers: authHeaders(api) });
    assert.equal(healthy.status, 200);
});

test('API: accepts valid JSON at limit bytes and rejects chunked over limit', async (t) => {
    let update = null;
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: (partial) => {
            update = partial;
            return {
                forwardSuggestionMode: false,
                thinkingAsText: false
            };
        }
    });
    t.after(api.close);

    const exactBody = padJsonToBytes({
        key: 'thinkingAsText',
        value: false
    }, 327_680);
    const exact = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: exactBody
    });
    assert.equal(exact.status, 200);
    assert.deepEqual(update, { thinkingAsText: false });
    assert.deepEqual(await exact.json(), {
        ok: true,
        data: {
            forwardSuggestionMode: false,
            thinkingAsText: false
        }
    });

    update = null;
    const oversized = await new Promise((resolve, reject) => {
        const request = http.request(`${api.origin}/api/settings`, {
            method: 'PATCH',
            headers: authHeaders(api, {
                Origin: api.origin,
                'Content-Type': 'application/json',
                'Transfer-Encoding': 'chunked'
            })
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
            }));
        });
        request.on('error', reject);
        request.write('x'.repeat(200_000));
        request.end('x'.repeat(127_681));
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(oversized.body, { ok: false, error: '请求体过大' });
    assert.equal(update, null);

    const healthy = await fetch(`${api.origin}/api/settings`, { headers: authHeaders(api) });
    assert.equal(healthy.status, 200);
});

test('API body: rejects Content-Length over limit before reading data', async () => {
    const req = createBodyRequest({ contentLength: 327_681 });
    const res = createJsonResponseRecorder();
    const handler = createBodyHandler({
        write: () => assert.fail('write should not run')
    });
    let settled = false;
    const handling = handler(req, res).then(() => {
        settled = true;
    });

    await flushAsyncTurn();
    const settledBeforeBody = settled;
    const dataListeners = req.listenerCount('data');
    const endListeners = req.listenerCount('end');
    if (!settledBeforeBody) {
        req.emit('end');
        await handling;
    }

    assert.equal(settledBeforeBody, true);
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { ok: false, error: '请求体过大' });
    assert.equal(dataListeners, 0);
    assert.equal(endListeners, 0);
    assert.equal(req.resumeCalls, 1);
});

test('API body: rejects chunked byte over limit before end and destroys after flush', async () => {
    const req = createBodyRequest();
    const res = createJsonResponseRecorder();
    const handler = createBodyHandler({
        write: () => assert.fail('write should not run')
    });
    let settled = false;
    const handling = handler(req, res).then(() => {
        settled = true;
    });

    req.emit('data', Buffer.alloc(200_000));
    req.emit('data', Buffer.alloc(127_680));
    await flushAsyncTurn();
    assert.equal(res.endCalls, 0);

    req.emit('data', Buffer.alloc(1));
    await flushAsyncTurn();
    const settledAtLimit = settled;
    const statusAtLimit = res.statusCode;
    const destroyCallsBeforeFlush = req.destroyCalls;
    if (!settledAtLimit) {
        req.emit('end');
        await handling;
    }

    assert.equal(settledAtLimit, true);
    assert.equal(statusAtLimit, 413);
    assert.equal(destroyCallsBeforeFlush, 0);
    assert.equal(req.listenerCount('data'), 0);
    assert.equal(req.listenerCount('end'), 0);
    assert.equal(req.listenerCount('error'), 0);
    assert.equal(req.listenerCount('aborted'), 0);

    res.flush();
    assert.equal(req.destroyCalls, 1);
    assert.deepEqual(res.json(), { ok: false, error: '请求体过大' });
});

test('API body: aborted request settles and clears resources', async () => {
    const timers = createManualBodyTimers();
    const req = createBodyRequest();
    const res = createJsonResponseRecorder();
    const handler = createBodyHandler({
        timers,
        write: () => assert.fail('write should not run')
    });
    let settled = false;
    const handling = handler(req, res).then(() => {
        settled = true;
    });

    req.emit('aborted');
    await flushAsyncTurn();
    const settledAtAbort = settled;
    if (!settledAtAbort) {
        req.emit('end');
        await handling;
    }

    assert.equal(settledAtAbort, true);
    assert.equal(res.statusCode, 400);
    assert.equal(timers.pendingCount, 0);
    assert.equal(req.listenerCount('data'), 0);
    assert.equal(req.listenerCount('end'), 0);
    assert.equal(req.listenerCount('error'), 0);
    assert.equal(req.listenerCount('aborted'), 0);
});

test('API body: absolute timeout returns 408 without data resets', async () => {
    const timers = createManualBodyTimers();
    const req = createBodyRequest();
    const res = createJsonResponseRecorder();
    const handler = createBodyHandler({
        timers,
        write: () => assert.fail('write should not run')
    });
    const handling = handler(req, res);

    const timerWasScheduled = timers.scheduled.length === 1;
    if (!timerWasScheduled) {
        req.emit('end');
        await handling;
    }
    assert.equal(timerWasScheduled, true);
    assert.deepEqual(timers.scheduled, [{ id: 1, delay: 37 }]);

    req.emit('data', Buffer.from('{"key":'));
    req.emit('data', Buffer.from('"thinkingAsText"'));
    assert.equal(timers.scheduled.length, 1);
    timers.fire(1);
    await handling;

    assert.equal(res.statusCode, 408);
    assert.deepEqual(res.json(), {
        ok: false,
        error: '请求体读取超时'
    });
    assert.equal(timers.pendingCount, 0);
    assert.deepEqual(timers.cleared, [1]);
    assert.equal(req.destroyCalls, 0);
    res.flush();
    assert.equal(req.destroyCalls, 1);

    const healthyReq = new EventEmitter();
    healthyReq.method = 'GET';
    healthyReq.url = '/api/settings';
    healthyReq.headers = {
        host: 'settings.test',
        'x-cc-proxy-token': 'test-token'
    };
    const healthyRes = createJsonResponseRecorder();
    await handler(healthyReq, healthyRes);
    assert.equal(healthyRes.statusCode, 200);
});

test('API body: successful completion cancels its timeout', async () => {
    const timers = createManualBodyTimers();
    const req = createBodyRequest();
    const res = createJsonResponseRecorder();
    const handler = createBodyHandler({ timers });
    const handling = handler(req, res);

    req.emit('data', Buffer.from(JSON.stringify({
        key: 'thinkingAsText',
        value: false
    })));
    req.emit('end');
    await handling;

    assert.equal(res.statusCode, 200);
    assert.deepEqual(timers.scheduled, [{ id: 1, delay: 37 }]);
    assert.deepEqual(timers.cleared, [1]);
    assert.equal(timers.pendingCount, 0);
});

test('API body: rejects invalid timeout values', () => {
    for (const bodyTimeoutMs of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        2_147_483_648,
        Number.MAX_SAFE_INTEGER
    ]) {
        assert.throws(
            () => createSettingsHandler({ bodyTimeoutMs }),
            /bodyTimeoutMs/
        );
    }
});

test('page route returns required security headers', async (t) => {
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    const response = await fetch(`${api.origin}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

function createLeaseResponse({
    failWriteHead = false,
    failWriteAt = 0,
    failEnd = false
} = {}) {
    const response = new EventEmitter();
    response.writes = [];
    response.endCalls = 0;
    response.writeHead = (status, headers) => {
        if (failWriteHead) throw new Error('write head failed');
        response.status = status;
        response.headers = headers;
    };
    let writeCalls = 0;
    response.write = (chunk) => {
        writeCalls += 1;
        if (writeCalls === failWriteAt) throw new Error('write failed');
        response.writes.push(chunk);
    };
    response.end = (chunk) => {
        response.endCalls += 1;
        if (chunk) response.writes.push(chunk);
        if (failEnd) throw new Error('end failed');
    };
    return response;
}

function createManualLifecycleScheduler() {
    let now = 0;
    let nextId = 1;
    const tasks = new Map();

    const schedule = (kind, callback, delay) => {
        const id = nextId++;
        tasks.set(id, {
            id,
            kind,
            callback,
            delay,
            dueAt: now + delay
        });
        return id;
    };
    const cancel = (id) => tasks.delete(id);
    const advanceBy = (milliseconds) => {
        const target = now + milliseconds;
        while (true) {
            const task = [...tasks.values()]
                .filter(({ dueAt }) => dueAt <= target)
                .sort((left, right) => (
                    left.dueAt - right.dueAt
                    || left.id - right.id
                ))[0];
            if (!task) break;

            now = task.dueAt;
            if (task.kind === 'timeout') tasks.delete(task.id);
            task.callback();
            if (task.kind === 'interval' && tasks.has(task.id)) {
                task.dueAt += task.delay;
            }
        }
        now = target;
    };

    return {
        scheduleTimeout: (callback, delay) => (
            schedule('timeout', callback, delay)
        ),
        cancelTimeout: cancel,
        scheduleInterval: (callback, delay) => (
            schedule('interval', callback, delay)
        ),
        cancelInterval: cancel,
        advanceBy,
        pending: () => [...tasks.values()].map(({
            id,
            kind,
            delay,
            dueAt
        }) => ({ id, kind, delay, dueAt }))
    };
}

function createLifecycleServer(closeBehavior = 'deferred') {
    const server = new EventEmitter();
    let closeCallback;
    server.closeCalls = 0;
    server.close = (callback) => {
        server.closeCalls += 1;
        if (closeBehavior === 'throw') {
            throw new Error('close failed');
        }
        if (closeBehavior === 'callback') {
            callback();
            return;
        }
        if (closeBehavior === 'deferred') closeCallback = callback;
    };
    server.completeClose = () => {
        const callback = closeCallback;
        closeCallback = undefined;
        callback?.();
    };
    return server;
}

function createLifecycleSocket({ destroyError } = {}) {
    const socket = new EventEmitter();
    socket.destroyCalls = 0;
    socket.destroyed = false;
    socket.destroy = () => {
        socket.destroyCalls += 1;
        if (destroyError) throw destroyError;
        socket.destroyed = true;
        socket.emit('close');
    };
    socket.close = () => socket.emit('close');
    return socket;
}

function createScheduledLifecycle(server, scheduler) {
    return createSessionLifecycle({
        server,
        heartbeatMs: 10_000,
        disconnectGraceMs: 2_000,
        firstConnectionTimeoutMs: 30_000,
        closeTimeoutMs: 1_000,
        scheduleTimeout: scheduler.scheduleTimeout,
        cancelTimeout: scheduler.cancelTimeout,
        scheduleInterval: scheduler.scheduleInterval,
        cancelInterval: scheduler.cancelInterval
    });
}

function createLifecycle({ closeBehavior = 'callback', ...overrides } = {}) {
    const scheduler = createManualLifecycleScheduler();
    const server = createLifecycleServer(closeBehavior);
    const lifecycle = createSessionLifecycle({
        server,
        heartbeatMs: 10_000,
        disconnectGraceMs: 2_000,
        firstConnectionTimeoutMs: 30_000,
        closeTimeoutMs: 1_000,
        scheduleTimeout: scheduler.scheduleTimeout,
        cancelTimeout: scheduler.cancelTimeout,
        scheduleInterval: scheduler.scheduleInterval,
        cancelInterval: scheduler.cancelInterval,
        ...overrides
    });
    return {
        lifecycle,
        scheduler,
        server,
        get closeCalls() { return server.closeCalls; }
    };
}

test('session: emits heartbeats and keeps multiple leases alive', async () => {
    const state = createLifecycle();
    const first = createLeaseResponse();
    const second = createLeaseResponse();

    state.lifecycle.onSession({}, first);
    state.lifecycle.onSession({}, second);
    state.scheduler.advanceBy(9_999);
    assert.deepEqual(first.writes, [': connected\n\n']);
    assert.deepEqual(second.writes, [': connected\n\n']);
    state.scheduler.advanceBy(1);

    assert.equal(first.status, 200);
    assert.equal(first.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.headers['x-content-type-options'], 'nosniff');
    assert.equal(first.headers.connection, 'keep-alive');
    assert.deepEqual(first.writes, [': connected\n\n', ': ping\n\n']);
    assert.deepEqual(second.writes, [': connected\n\n', ': ping\n\n']);
    first.emit('close');
    assert.equal(state.closeCalls, 0);
    state.lifecycle.close();
    await state.lifecycle.finished;
});

test('session: closes after the last lease grace period', async () => {
    const state = createLifecycle();
    const lease = createLeaseResponse();

    state.lifecycle.onSession({}, lease);
    lease.emit('close');
    state.scheduler.advanceBy(1_999);
    assert.equal(state.closeCalls, 0);
    state.scheduler.advanceBy(1);
    await state.lifecycle.finished;

    assert.equal(state.closeCalls, 1);
    assert.equal(lease.endCalls, 0);
});

test('lease: reconnect during grace period cancels shutdown', async () => {
    const state = createLifecycle();
    const first = createLeaseResponse();
    const second = createLeaseResponse();

    state.lifecycle.onSession({}, first);
    first.emit('close');
    state.scheduler.advanceBy(1_999);
    state.lifecycle.onSession({}, second);
    state.scheduler.advanceBy(1);

    assert.equal(state.closeCalls, 0);
    assert.equal(second.endCalls, 0);
    state.lifecycle.close();
    await state.lifecycle.finished;
});

test('session: closes when no page connects before timeout', async () => {
    const state = createLifecycle();

    state.scheduler.advanceBy(29_999);
    assert.equal(state.closeCalls, 0);
    state.scheduler.advanceBy(1);
    await state.lifecycle.finished;

    assert.equal(state.closeCalls, 1);
});

test('session: exposes production timing defaults', () => {
    assert.deepEqual(SESSION_TIMING, {
        heartbeatMs: 10_000,
        disconnectGraceMs: 2_000,
        firstConnectionTimeoutMs: 30_000,
        closeTimeoutMs: 1_000
    });
    assert.equal(Object.isFrozen(SESSION_TIMING), true);
});

test('lease: heartbeat failure releases the last lease', async () => {
    const state = createLifecycle();
    const lease = createLeaseResponse({ failWriteAt: 2 });

    state.lifecycle.onSession({}, lease);
    state.scheduler.advanceBy(10_000);
    assert.equal(lease.endCalls, 1);
    state.scheduler.advanceBy(1_999);
    assert.equal(state.closeCalls, 0);
    state.scheduler.advanceBy(1);
    await state.lifecycle.finished;

    assert.equal(state.closeCalls, 1);
    assert.equal(lease.endCalls, 1);
});

test('lease: duplicate close and error events release only once', async () => {
    const state = createLifecycle();
    const lease = createLeaseResponse();

    state.lifecycle.onSession({}, lease);
    lease.emit('close');
    lease.emit('error');
    state.scheduler.advanceBy(2_000);
    await state.lifecycle.finished;

    assert.equal(state.closeCalls, 1);
});

test('session: active close ends all responses and closes once', async () => {
    const state = createLifecycle();
    const first = createLeaseResponse({ failEnd: true });
    const second = createLeaseResponse();

    state.lifecycle.onSession({}, first);
    state.lifecycle.onSession({}, second);
    state.lifecycle.close();
    state.lifecycle.close();
    await state.lifecycle.finished;

    assert.equal(first.endCalls, 1);
    assert.equal(second.endCalls, 1);
    assert.equal(state.closeCalls, 1);
});

test('session: close throw or missing callback still settles', async (t) => {
    for (const closeBehavior of ['throw', 'none']) {
        await t.test(closeBehavior, async () => {
            const state = createLifecycle({ closeBehavior });
            state.lifecycle.close();
            if (closeBehavior === 'none') {
                state.scheduler.advanceBy(1_000);
            }
            await state.lifecycle.finished;
            assert.equal(state.closeCalls, 1);
        });
    }
});

test('lease: repeated error and close sequences remain handled', async (t) => {
    for (const sequence of [
        ['error', 'error'],
        ['error', 'close'],
        ['close', 'error']
    ]) {
        await t.test(sequence.join('-'), async () => {
            const state = createLifecycle();
            const lease = createLeaseResponse();
            state.lifecycle.onSession({}, lease);
            for (const event of sequence) lease.emit(event, new Error(event));
            state.scheduler.advanceBy(2_000);
            await state.lifecycle.finished;
            assert.equal(state.closeCalls, 1);
        });
    }
});

test('lease: initial header or body failure releases the lease', async (t) => {
    for (const options of [{ failWriteHead: true }, { failWriteAt: 1 }]) {
        await t.test(JSON.stringify(options), async () => {
            const state = createLifecycle();
            const lease = createLeaseResponse(options);
            state.lifecycle.onSession({}, lease);
            state.scheduler.advanceBy(2_000);
            await state.lifecycle.finished;
            assert.equal(state.closeCalls, 1);
            assert.equal(lease.endCalls, 1);
        });
    }
});

test('session: rejects new lease with 503 while closing', async () => {
    const state = createLifecycle({ closeBehavior: 'none' });
    state.lifecycle.close();
    const response = createLeaseResponse();

    state.lifecycle.onSession({}, response);
    state.scheduler.advanceBy(1_000);
    await state.lifecycle.finished;

    assert.equal(response.status, 503);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(JSON.parse(response.writes.join('')), {
        ok: false,
        error: '设置服务正在关闭'
    });
});

test('session: close callback cancels fallback without duplicate close', async () => {
    const state = createLifecycle();
    state.lifecycle.close();
    await state.lifecycle.finished;
    assert.deepEqual(state.scheduler.pending(), []);
    state.scheduler.advanceBy(1_000);
    assert.equal(state.closeCalls, 1);
});

test('session sockets: normal close callback never force-destroys sockets', async () => {
    const scheduler = createManualLifecycleScheduler();
    const server = createLifecycleServer('deferred');
    const baselineListeners = server.listenerCount('connection');
    const lifecycle = createScheduledLifecycle(server, scheduler);
    const socket = createLifecycleSocket();

    assert.equal(
        server.listenerCount('connection'),
        baselineListeners + 1
    );
    server.emit('connection', socket);
    lifecycle.close();
    assert.equal(socket.destroyCalls, 0);

    server.completeClose();
    await lifecycle.finished;
    scheduler.advanceBy(1_000);

    assert.equal(socket.destroyCalls, 0);
    assert.equal(
        server.listenerCount('connection'),
        baselineListeners
    );
});

test('session sockets: fallback destroys only sockets still open at 1 second', async () => {
    const scheduler = createManualLifecycleScheduler();
    const server = createLifecycleServer('deferred');
    const lifecycle = createScheduledLifecycle(server, scheduler);
    const closed = createLifecycleSocket();
    const remaining = createLifecycleSocket();

    server.emit('connection', closed);
    server.emit('connection', remaining);
    closed.close();
    lifecycle.close();

    scheduler.advanceBy(999);
    assert.equal(remaining.destroyCalls, 0);
    scheduler.advanceBy(1);
    const remainingDestroyCalls = remaining.destroyCalls;

    server.completeClose();
    await lifecycle.finished;

    assert.equal(closed.destroyCalls, 0);
    assert.equal(remainingDestroyCalls, 1);
});

test('session sockets: fallback continues after a socket destroy throws', async () => {
    const scheduler = createManualLifecycleScheduler();
    const server = createLifecycleServer('deferred');
    const lifecycle = createScheduledLifecycle(server, scheduler);
    const failing = createLifecycleSocket({
        destroyError: new Error('destroy failed')
    });
    const succeeding = createLifecycleSocket();

    server.emit('connection', failing);
    server.emit('connection', succeeding);
    lifecycle.close();
    scheduler.advanceBy(1_000);
    const destroyCalls = [
        failing.destroyCalls,
        succeeding.destroyCalls
    ];

    server.completeClose();
    await lifecycle.finished;

    assert.deepEqual(destroyCalls, [1, 1]);
    assert.equal(succeeding.destroyed, true);
});

function createBrowserHarness() {
    const calls = [];
    let errorListener = null;
    let unrefCalls = 0;
    let output = '';
    return {
        calls,
        spawnProcess(command, args, options) {
            calls.push({ command, args, options });
            return {
                on(event, listener) {
                    if (event === 'error') errorListener = listener;
                },
                unref() {
                    unrefCalls += 1;
                }
            };
        },
        output: { write: (value) => { output += value; } },
        emitError: () => errorListener?.(new Error('opener failed')),
        get unrefCalls() { return unrefCalls; },
        get printed() { return output; }
    };
}

test('browser: prints URL and opens macOS default browser detached', () => {
    const harness = createBrowserHarness();
    const url = 'http://127.0.0.1:4321/';

    openSettingsPage(url, {
        platform: 'darwin',
        spawnProcess: harness.spawnProcess,
        output: harness.output
    });

    assert.equal(harness.printed, `[cc-proxy] settings: ${url}\n`);
    assert.deepEqual(harness.calls, [{
        command: 'open',
        args: [url],
        options: { detached: true, stdio: 'ignore' }
    }]);
    assert.equal(harness.unrefCalls, 1);
});

test('browser: selects Windows and Linux default opener', () => {
    const url = 'http://127.0.0.1:4321/';
    const windows = createBrowserHarness();
    const linux = createBrowserHarness();

    openSettingsPage(url, {
        platform: 'win32',
        spawnProcess: windows.spawnProcess,
        output: windows.output
    });
    openSettingsPage(url, {
        platform: 'linux',
        spawnProcess: linux.spawnProcess,
        output: linux.output
    });

    assert.deepEqual(windows.calls[0], {
        command: 'rundll32.exe',
        args: ['url.dll,FileProtocolHandler', url],
        options: { detached: true, stdio: 'ignore', windowsHide: true }
    });
    assert.deepEqual(linux.calls[0], {
        command: 'xdg-open',
        args: [url],
        options: { detached: true, stdio: 'ignore' }
    });
});

test('browser: opener error does not escape', () => {
    const harness = createBrowserHarness();
    openSettingsPage('http://127.0.0.1:4321/', {
        platform: 'darwin',
        spawnProcess: harness.spawnProcess,
        output: harness.output
    });

    assert.doesNotThrow(harness.emitError);
});

test('browser: rejects non-loopback and non-HTTP URLs', () => {
    const harness = createBrowserHarness();

    assert.equal(openSettingsPage('https://127.0.0.1:4321/', {
        spawnProcess: harness.spawnProcess,
        output: harness.output
    }), false);
    assert.equal(openSettingsPage('http://localhost:4321/', {
        spawnProcess: harness.spawnProcess,
        output: harness.output
    }), false);
    assert.equal(openSettingsPage('not-a-url', {
        spawnProcess: harness.spawnProcess,
        output: harness.output
    }), false);
    assert.equal(openSettingsPage('http://127.0.0.1:4321/?token=secret', {
        spawnProcess: harness.spawnProcess,
        output: harness.output
    }), false);
    assert.equal(openSettingsPage('http://127.0.0.1:4321/#secret', {
        spawnProcess: harness.spawnProcess,
        output: harness.output
    }), false);
    assert.equal(harness.calls.length, 0);
});

test('browser: output failure still attempts browser launch', () => {
    const harness = createBrowserHarness();
    const result = openSettingsPage('http://127.0.0.1:4321/', {
        platform: 'darwin',
        spawnProcess: harness.spawnProcess,
        output: { write: () => { throw new Error('broken pipe'); } }
    });

    assert.equal(result, true);
    assert.equal(harness.calls.length, 1);
});

test('browser: synchronous opener failures do not escape', async (t) => {
    const url = 'http://127.0.0.1:4321/';
    const cases = [
        () => { throw new Error('spawn failed'); },
        () => ({ on: () => { throw new Error('listener failed'); }, unref() {} }),
        () => ({ on() {}, unref: () => { throw new Error('unref failed'); } }),
        () => ({})
    ];

    for (const [index, spawnProcess] of cases.entries()) {
        await t.test(String(index), () => {
            assert.doesNotThrow(() => openSettingsPage(url, {
                platform: 'darwin',
                spawnProcess,
                output: { write() {} }
            }));
        });
    }
});

test('service: listens on loopback, opens base URL without token and exits', async () => {
    let openedUrl = null;
    let listenHost = null;
    await runSettingsWeb({
        createToken: () => 'fixed-token',
        openPage: (url) => { openedUrl = url; },
        createLifecycle: ({ server }) => {
            const finished = new Promise((resolve) => {
                setTimeout(() => server.close(resolve), 5);
            });
            return { onSession: () => {}, close: () => {}, finished };
        },
        createServer: () => {
            const server = http.createServer();
            const listen = server.listen.bind(server);
            server.listen = (port, host, callback) => {
                listenHost = host;
                return listen(port, host, callback);
            };
            return server;
        },
        output: { write() {} }
    });

    assert.equal(listenHost, '127.0.0.1');
    assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.doesNotMatch(openedUrl, /[?#]/);
    assert.doesNotMatch(openedUrl, /fixed-token/);
});

function createServiceFailureHarness({
    failure,
    closeRejects = false,
    closeThrows = false,
    pendingFinished = false
}) {
    const server = new EventEmitter();
    let closeCalls = 0;
    let offCalls = 0;
    server.off = (...args) => {
        offCalls += 1;
        return EventEmitter.prototype.off.apply(server, args);
    };
    server.listen = (_port, _host, callback) => {
        if (failure === 'sync-listen') throw new Error('listen failed');
        if (failure === 'async-listen') {
            queueMicrotask(() => server.emit('error', new Error('listen failed')));
            return;
        }
        callback();
    };
    server.address = () => {
        if (failure === 'null-address') return null;
        if (failure === 'string-address') return '/tmp/socket';
        return { port: 4321 };
    };
    const lifecycle = {
        onSession() {},
        close() {
            closeCalls += 1;
            if (closeThrows) throw new Error('close failed');
        },
        finished: pendingFinished
            ? new Promise(() => {})
            : closeRejects
                ? Promise.reject(new Error('lifecycle failed'))
                : Promise.resolve()
    };
    return {
        server,
        lifecycle,
        get closeCalls() { return closeCalls; },
        get offCalls() { return offCalls; }
    };
}

test('service: cleans up after listen and address failures', async (t) => {
    for (const failure of [
        'sync-listen',
        'async-listen',
        'null-address',
        'string-address'
    ]) {
        await t.test(failure, async () => {
            const harness = createServiceFailureHarness({ failure });
            await assert.rejects(runSettingsWeb({
                createServer: () => harness.server,
                createLifecycle: () => harness.lifecycle,
                openPage: () => assert.fail('browser should not open')
            }));
            assert.equal(harness.closeCalls, 1);
            assert.ok(harness.offCalls >= 1);
            assert.equal(harness.server.listenerCount('error'), 0);
        });
    }
});

test('service: cleans up after opener or lifecycle failure', async (t) => {
    await t.test('opener', async () => {
        const harness = createServiceFailureHarness({});
        await assert.rejects(runSettingsWeb({
            createServer: () => harness.server,
            createLifecycle: () => harness.lifecycle,
            openPage: () => { throw new Error('open failed'); }
        }));
        assert.equal(harness.closeCalls, 1);
    });

    await t.test('lifecycle', async () => {
        const harness = createServiceFailureHarness({ closeRejects: true });
        await assert.rejects(runSettingsWeb({
            createServer: () => harness.server,
            createLifecycle: () => harness.lifecycle,
            openPage: () => {}
        }), /lifecycle failed/);
        assert.equal(harness.closeCalls, 1);
    });
});

test('service: runtime server error triggers cleanup', async () => {
    const harness = createServiceFailureHarness({ pendingFinished: true });
    const running = runSettingsWeb({
        createServer: () => harness.server,
        createLifecycle: () => harness.lifecycle,
        openPage: () => {
            queueMicrotask(() => harness.server.emit('error', new Error('runtime failed')));
        },
        cleanupTimeoutMs: 5
    });

    await assert.rejects(running, /runtime failed/);
    assert.equal(harness.closeCalls, 1);
    assert.equal(harness.server.listenerCount('error'), 0);
});

test('service: cleanup preserves original error when close throws', async () => {
    const harness = createServiceFailureHarness({ closeThrows: true });
    await assert.rejects(runSettingsWeb({
        createServer: () => harness.server,
        createLifecycle: () => harness.lifecycle,
        openPage: () => { throw new Error('original failure'); }
    }), /original failure/);
    assert.equal(harness.closeCalls, 1);
});

test('service: cleanup timeout prevents pending lifecycle hang', async () => {
    const harness = createServiceFailureHarness({ pendingFinished: true });
    const startedAt = Date.now();
    await assert.rejects(runSettingsWeb({
        createServer: () => harness.server,
        createLifecycle: () => harness.lifecycle,
        openPage: () => { throw new Error('open failed'); },
        cleanupTimeoutMs: 5
    }), /open failed/);
    assert.ok(Date.now() - startedAt < 100);
    assert.equal(harness.closeCalls, 1);
});
