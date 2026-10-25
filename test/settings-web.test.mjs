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

test('page: renders dark settings page with exactly five switches', () => {
    const html = renderSettingsPage();
    const switches = html.match(/<input[^>]+type="checkbox"/g) ?? [];

    assert.match(html, /<title>cc-proxy 设置<\/title>/);
    assert.equal(switches.length, 5);
    assert.match(html, /id="forwardSuggestionMode"/);
    assert.match(html, /id="thinkingAsText"/);
    assert.match(html, /id="effortOverrideEnabled"/);
    assert.match(html, /id="effortOverrideLevel"/);
    assert.match(html, /id="systemPromptOverrideEnabled"/);
    assert.match(html, /id="systemPromptTemplate"/);
    assert.match(html, /id="systemPromptOverridePrompt"/);
    assert.match(html, /id="usageScaleEnabled"/);
    assert.match(html, /id="usageScaleRatio"/);
    // 定向目标上游列表：两个特性各一套（key 前缀区分）。
    assert.match(html, /id="scaleTargetList"/);
    assert.match(html, /id="scaleTargetAdd"/);
    assert.match(html, /id="effortTargetList"/);
    assert.match(html, /id="effortTargetAdd"/);
    assert.match(html, /留空 = 对所有上游缩放/);
    assert.match(html, /留空 = 对所有上游覆写/);
    // Effort 列表额外说明：档位继承语义与多条命中的仲裁规则。
    assert.match(html, /继承全局/);
    assert.match(html, /路径更长（更具体）的条目录生效/);
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

test('page: contains usage board nodes', () => {
    const html = renderSettingsPage();

    assert.match(html, /用量看板（近 30 天）/);
    assert.match(html, /id="usageBoard"/);
    assert.match(html, /id="usagePlaceholder"/);
    assert.match(html, /usage-bars/);
    assert.match(html, /usage-bar-fill/);
    assert.match(html, /usage-table/);
    assert.match(html, /alert-dot/);
    assert.match(html, /\/api\/usage/);
    assert.match(html, /usage-export-btn/);
    assert.match(html, /api\/usage\/export/);
    assert.match(html, /--warn/);
    assert.match(html, /usage-bar-fill\.warn/);
    assert.match(html, /alert-dot\.warn/);
});

test('page: contains upstream health board nodes', () => {
    const html = renderSettingsPage();

    assert.match(html, /上游状态/);
    assert.match(html, /id="healthBoard"/);
    assert.match(html, /id="healthPlaceholder"/);
    assert.match(html, /aria-label="上游状态"/);
    assert.match(html, /\/api\/upstream-health/);
    assert.match(html, /暂无上游请求数据/);
});

test('page: contains recent requests board nodes', () => {
    const html = renderSettingsPage();

    assert.match(html, /最近请求/);
    assert.match(html, /id="recentRequestsBoard"/);
    assert.match(html, /id="recentRequestsPlaceholder"/);
    assert.match(html, /aria-label="最近请求"/);
    assert.match(html, /\/api\/recent-requests/);
    assert.match(html, /暂无最近请求数据/);
    assert.match(html, /最近请求不可用/);
    // 详情行展开后的脱敏头摘要（请求头/响应头前缀）。
    assert.match(html, /请求头 /);
    assert.match(html, /响应头 /);
});

test('API: GET /api/recent-requests returns snapshot, empty fallback and 405', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-requests-api-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const logFile = path.join(home, '.cc-proxy', 'runtime', 'recent-requests.json');
    const realHomedir = os.homedir;
    os.homedir = () => home;
    t.after(() => { os.homedir = realHomedir; });

    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    // 缺失文件：返回空快照而非报错。
    const missing = await fetch(`${api.origin}/api/recent-requests`, { headers: authHeaders(api) });
    assert.equal(missing.status, 200);
    const missingBody = await missing.json();
    assert.equal(missingBody.ok, true);
    assert.deepEqual(missingBody.data, { updatedAt: null, entries: [] });

    // 落盘快照：原样读回（只读不缓存，每次请求重读文件）。
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const snapshot = {
        updatedAt: '2026-10-15T08:00:00.000Z',
        entries: [{
            time: '2026-10-15T08:00:00.000Z',
            upstream: 'api.anthropic.com',
            model: 'claude-sonnet-5',
            statusCode: 200,
            ttftMs: 320,
            thinkingRewritten: true,
            failedOver: false,
            requestHeaders: { 'x-api-key': '***abcd' },
            responseHeaders: { 'content-type': 'text/event-stream' }
        }]
    };
    fs.writeFileSync(logFile, JSON.stringify(snapshot));
    const ok = await fetch(`${api.origin}/api/recent-requests`, { headers: authHeaders(api) });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.deepEqual(okBody.data, snapshot);

    // 损坏文件：回退空快照。
    fs.writeFileSync(logFile, '{not json');
    const corrupt = await fetch(`${api.origin}/api/recent-requests`, { headers: authHeaders(api) });
    assert.deepEqual((await corrupt.json()).data, { updatedAt: null, entries: [] });

    // 非 GET：405 + Allow。
    const post = await fetch(`${api.origin}/api/recent-requests`, {
        method: 'POST',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: '{}'
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');

    // 无 token：401（认证链在 handler 之前统一执行）。
    const unauthorized = await fetch(`${api.origin}/api/recent-requests`);
    assert.equal(unauthorized.status, 401);
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
    const el = {
        checked: false,
        disabled,
        value: '',
        textContent: '',
        // 导出按钮模拟：click() 仅打标，供断言下载链路触发。
        clicked: false,
        click() {
            this.clicked = true;
        },
        // select 元素模拟：appendChild 收集子 option，供 syncTemplateSelect 遍历比对。
        options: [],
        appendChild(child) {
            this.options.push(child);
        },
        // 详情行插入：row.after(detail) 依赖兄弟插入（最近请求表展开详情）。
        after(...nodes) {
            this.options.push(...nodes);
        },
        remove() {
            this.removed = true;
        },
        nextSibling: null,
        style: {},
        // alert-dot 设置 aria-label 需要setAttribute。
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        attributes: {},
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
        async dispatch(type) {
            await listeners.get(type)?.({
                type, button: 0, target: this, currentTarget: this,
                preventDefault() {}
            });
        }
    };
    // className 与 classList 联动：详情行按 className==='request-detail' 判定，
    // mock 下需同步到 classes Set 才能命中 nextSibling.remove() 分支。
    Object.defineProperty(el, 'className', {
        get: () => [...classes].join(' '),
        set: (value) => {
            classes.clear();
            for (const name of String(value).split(/\s+/)) {
                if (name) classes.add(name);
            }
        }
    });
    return el;
}

async function flushPageMicrotasks() {
    // 24 轮：覆盖 bootstrap → load → session → captured 预填的最长微任务链
    //（实测约 21 轮，超出原 12 轮一倍，留 3 轮余量）。
    for (let index = 0; index < 24; index += 1) {
        await Promise.resolve();
    }
}

// 定向缩放列表容器：模拟 textContent='' 清空子元素 + appendChild 收集。
function createListElement() {
    const el = createPageElement();
    let children = [];
    el.appendChild = (child) => {
        children.push(child);
    };
    Object.defineProperty(el, 'textContent', {
        configurable: true,
        get: () => '',
        set: (value) => {
            if (value === '') children = [];
        }
    });
    Object.defineProperty(el, 'children', { get: () => children });
    return el;
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
        usageScaleEnabled: createPageElement({
            disabled: /\bdisabled\b/i.test(
                inputTag('usageScaleEnabled')
            )
        }),
        usageScaleRatio: createPageElement({
            disabled: /\bdisabled\b/i.test(
                inputTag('usageScaleRatio')
            )
        }),
        scaleTargetList: createListElement(),
        scaleTargetAdd: createPageElement({
            disabled: /\bdisabled\b/i.test(
                html.match(/<button[^>]+id="scaleTargetAdd"[^>]*>/i)?.[0] ?? ''
            )
        }),
        effortTargetList: createListElement(),
        effortTargetAdd: createPageElement({
            disabled: /\bdisabled\b/i.test(
                html.match(/<button[^>]+id="effortTargetAdd"[^>]*>/i)?.[0] ?? ''
            )
        }),
        status: createPageElement(),
        usageBoard: createPageElement(),
        healthBoard: createPageElement(),
        healthPlaceholder: createPageElement(),
        recentRequestsBoard: createPageElement(),
        recentRequestsPlaceholder: createPageElement()
    };
    const calls = [];
    // 导出下载链路：记录 createElement 产物与 blob URL 生命周期。
    const created = [];
    const objectUrls = [];
    const revokedUrls = [];
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
            createElement: () => {
                const el = createPageElement();
                created.push(el);
                return el;
            },
            createTextNode: (text) => ({ textContent: text, nodeType: 3 })
        },
        // URL 需同时支持 new URL(...)（定向缩放列表本地校验）与静态
        // createObjectURL/revokeObjectURL（用量导出下载链路）。
        URL: class extends URL {
            static createObjectURL(blob) {
                const url = 'blob:mock-' + objectUrls.length;
                objectUrls.push({ blob, url });
                return url;
            }
            static revokeObjectURL(url) {
                revokedUrls.push(url);
            }
        },
        // 导出下载链路的 revoke 推迟到宏任务，沙箱需显式注入宿主定时器。
        setTimeout,
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
        created,
        objectUrls,
        revokedUrls,
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
        if (url === '/api/usage') {
            return pageJsonResponse(200, {
                ok: true,
                data: { days: [], alert: { dailyTokens: 0, exceeded: false } }
            });
        }
        if (url === '/api/upstream-health') {
            return pageJsonResponse(200, { ok: true, data: { upstreams: [], failovers: [] } });
        }
        if (url === '/api/recent-requests') {
            return pageJsonResponse(200, { ok: true, data: { updatedAt: null, entries: [] } });
        }
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
        '/api/usage',
        '/api/upstream-health',
        '/api/recent-requests',
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

test('page script: applySettings backfill syncs template select display', async () => {
    // 从渲染产物提取 SYSTEM_PROMPT_TEMPLATES，取「写作助手」全文构造回填场景。
    const script = [...renderSettingsPage('vm-bootstrap').matchAll(/<script>([\s\S]*?)<\/script>/gi)][0][1];
    const declStart = script.indexOf('const SYSTEM_PROMPT_TEMPLATES');
    const declEnd = script.indexOf('];', declStart) + 2;
    const templates = new Function(
        script.slice(declStart, declEnd) + '; return SYSTEM_PROMPT_TEMPLATES;'
    )();
    const writer = templates.find(({ name }) => name === '写作助手');

    const page = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, {
                ok: true,
                data: { token: 'vm-token' }
            });
        }
        if (url === '/api/session') return pageSessionResponse();
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high' },
                systemPromptOverride: { enabled: true, prompt: writer.text }
            }
        });
    });
    await flushPageMicrotasks();

    // 权威快照回填的 prompt 即使与模板全文一致，下拉也默认回落 CC官方
    // （selectedTemplate 仅由用户手动选择设置）。
    assert.equal(page.elements.systemPromptOverridePrompt.value, writer.text);
    assert.equal(page.elements.systemPromptTemplate.value, '__CC_OFFICIAL__');
});

test('page script: template select resets to CC官方 on input and applySettings', async () => {
    const page = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (url === '/api/settings') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: false, level: 'high' },
                    systemPromptOverride: { enabled: false, prompt: '' },
                        usageScale: { enabled: false, ratio: 1, baseUrls: [] }
                }
            });
        }
        return pageJsonResponse(200, { ok: true, data: {} });
    });
    await flushPageMicrotasks();

    const select = page.elements.systemPromptTemplate;
    const textarea = page.elements.systemPromptOverridePrompt;

    // 模拟用户手动选中某条模板（options[1] 为第一条预置模板）。
    select.value = select.options[1].value;
    await select.dispatch('change');
    assert.equal(select.value, select.options[1].value);

    // 输入框编辑（input 事件）→ 复位回落 CC官方。
    textarea.value = '手动编辑的内容';
    await textarea.dispatch('input');
    assert.equal(select.value, '__CC_OFFICIAL__');

    // 再次手动选中模板后，任一字段保存触发 applySettings 回填 → 复位为 CC官方。
    select.value = select.options[1].value;
    await select.dispatch('change');
    assert.equal(select.value, select.options[1].value);
    await page.change('thinkingAsText', true);
    assert.equal(select.value, '__CC_OFFICIAL__');
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
                    systemPromptOverride: { enabled: false, prompt: '' },
                        usageScale: { enabled: false, ratio: 1, baseUrls: [] }
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
                    systemPromptOverride: { enabled: false, prompt: '' },
                        usageScale: { enabled: false, ratio: 1, baseUrls: [] }
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
                    systemPromptOverride: { enabled: false, prompt: '' },
                        usageScale: { enabled: false, ratio: 1, baseUrls: [] }
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
                    systemPromptOverride: { enabled: false, prompt: '' },
                        usageScale: { enabled: false, ratio: 1, baseUrls: [] }
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

test('page script: scale target list renders, adds, removes and submits baseUrls', async (t) => {
    const patched = [];
    const page = createPageHarness(({ url, options }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/captured-system-prompt') {
            return pageJsonResponse(200, { ok: true, data: { prompt: null } });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (options.method === 'PATCH') {
            patched.push(JSON.parse(options.body));
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: true, level: 'high' },
                    systemPromptOverride: { enabled: false, prompt: '' },
                    usageScale: {
                        enabled: true,
                        ratio: 0.5,
                        baseUrls: JSON.parse(options.body).value
                    }
                }
            });
        }
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high' },
                systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: {
                    enabled: true,
                    ratio: 0.5,
                    baseUrls: ['https://a.com/api', 'http://b.com:8080']
                }
            }
        });
    });
    await flushPageMicrotasks();

    // 加载后按权威快照渲染两行，控件已启用。
    assert.equal(page.elements.scaleTargetList.children.length, 2);
    assert.equal(page.elements.scaleTargetAdd.disabled, false);
    const firstInput = page.elements.scaleTargetList.children[0].options[0];
    assert.equal(firstInput.value, 'https://a.com/api');

    // 新增一行并填入合法 URL：blur 全量提交。
    await page.elements.scaleTargetAdd.dispatch('pointerdown');
    await page.elements.scaleTargetAdd.dispatch('click');
    assert.equal(page.elements.scaleTargetList.children.length, 3);
    const newRow = page.elements.scaleTargetList.children[2];
    const newInput = newRow.options[0];
    newInput.value = 'https://c.com';
    await newInput.dispatch('blur');
    await flushPageMicrotasks();
    assert.equal(patched.length, 1);
    assert.equal(patched[0].key, 'usageScale.baseUrls');
    assert.deepEqual(patched[0].value,
        ['https://a.com/api', 'http://b.com:8080', 'https://c.com']);

    // 删除首行：提交剩余两项。
    const firstRemove = page.elements.scaleTargetList.children[0].options[1];
    await firstRemove.dispatch('pointerdown');
    await firstRemove.dispatch('click');
    await flushPageMicrotasks();
    assert.equal(patched.length, 2);
    assert.deepEqual(patched[1].value, ['http://b.com:8080', 'https://c.com']);
});

test('page script: invalid scale target URL blocks submit and rolls back', async (t) => {
    let patched = 0;
    const page = createPageHarness(({ url, options }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/captured-system-prompt') {
            return pageJsonResponse(200, { ok: true, data: { prompt: null } });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (options.method === 'PATCH') {
            patched += 1;
            return pageJsonResponse(200, { ok: true, data: {} });
        }
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high' },
                systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: { enabled: false, ratio: 1, baseUrls: ['https://a.com'] }
            }
        });
    });
    await flushPageMicrotasks();
    assert.equal(page.elements.scaleTargetList.children.length, 1);

    // 非法 URL（缺协议）：不提交、提示错误、回滚为快照值。
    const input = page.elements.scaleTargetList.children[0].options[0];
    input.value = 'not a url';
    await input.dispatch('blur');
    await flushPageMicrotasks();
    assert.equal(patched, 0);
    assert.equal(page.elements.status.textContent, '目标上游须为 http(s) URL');
    assert.equal(page.elements.scaleTargetList.children.length, 1);
    assert.equal(
        page.elements.scaleTargetList.children[0].options[0].value,
        'https://a.com'
    );

    // 非 http(s) 协议同样拦截。
    const input2 = page.elements.scaleTargetList.children[0].options[0];
    input2.value = 'ftp://a.com';
    await input2.dispatch('blur');
    await flushPageMicrotasks();
    assert.equal(patched, 0);
});

test('page script: effort target list renders, adds, removes and submits baseUrls', async (t) => {
    const patched = [];
    const page = createPageHarness(({ url, options }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/captured-system-prompt') {
            return pageJsonResponse(200, { ok: true, data: { prompt: null } });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (options.method === 'PATCH') {
            const body = JSON.parse(options.body);
            patched.push(body);
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: {
                        enabled: true, level: 'high', baseUrls: body.value
                    },
                    systemPromptOverride: { enabled: false, prompt: '' },
                    usageScale: { enabled: false, ratio: 1, baseUrls: [] }
                }
            });
        }
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: {
                    enabled: true, level: 'high',
                    baseUrls: ['https://a.com/api', 'http://b.com:8080']
                },
                systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: { enabled: false, ratio: 1, baseUrls: [] }
            }
        });
    });
    await flushPageMicrotasks();

    // 加载后按权威快照渲染两行，控件已启用。
    assert.equal(page.elements.effortTargetList.children.length, 2);
    assert.equal(page.elements.effortTargetAdd.disabled, false);
    assert.equal(
        page.elements.effortTargetList.children[0].options[0].value,
        'https://a.com/api'
    );

    // 新增一行并填入合法 URL：blur 全量提交 effortOverride.baseUrls。
    await page.elements.effortTargetAdd.dispatch('pointerdown');
    await page.elements.effortTargetAdd.dispatch('click');
    assert.equal(page.elements.effortTargetList.children.length, 3);
    const newInput = page.elements.effortTargetList.children[2].options[0];
    newInput.value = 'https://c.com';
    await newInput.dispatch('blur');
    await flushPageMicrotasks();
    assert.equal(patched.length, 1);
    assert.equal(patched[0].key, 'effortOverride.baseUrls');
    assert.deepEqual(patched[0].value,
        ['https://a.com/api', 'http://b.com:8080', 'https://c.com']);

    // 删除首行：提交剩余两项（两个列表各自独立提交，互不影响）。
    // 行元素顺序为 [URL input, 档位 select, 删除按钮]。
    const firstRemove = page.elements.effortTargetList.children[0].options[2];
    await firstRemove.dispatch('pointerdown');
    await firstRemove.dispatch('click');
    await flushPageMicrotasks();
    assert.equal(patched.length, 2);
    assert.deepEqual(patched[1].value, ['http://b.com:8080', 'https://c.com']);
});

test('page script: invalid effort target URL blocks submit and rolls back', async (t) => {
    let patched = 0;
    const page = createPageHarness(({ url, options }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/captured-system-prompt') {
            return pageJsonResponse(200, { ok: true, data: { prompt: null } });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (options.method === 'PATCH') {
            patched += 1;
            return pageJsonResponse(200, { ok: true, data: {} });
        }
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: {
                    enabled: true, level: 'high', baseUrls: ['https://a.com']
                },
                systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: { enabled: false, ratio: 1, baseUrls: [] }
            }
        });
    });
    await flushPageMicrotasks();
    assert.equal(page.elements.effortTargetList.children.length, 1);

    // 非法 URL（缺协议）：不提交、提示错误、回滚为快照值。
    const input = page.elements.effortTargetList.children[0].options[0];
    input.value = 'not a url';
    await input.dispatch('blur');
    await flushPageMicrotasks();
    assert.equal(patched, 0);
    assert.equal(page.elements.status.textContent, '目标上游须为 http(s) URL');
    assert.equal(
        page.elements.effortTargetList.children[0].options[0].value,
        'https://a.com'
    );
});

test('page script: effort target row renders level select, object entries preselect level', async (t) => {
    const page = createPageHarness(({ url, options }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/captured-system-prompt') {
            return pageJsonResponse(200, { ok: true, data: { prompt: null } });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (options.method === 'PATCH') return pageJsonResponse(200, { ok: true, data: {} });
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: {
                    enabled: true, level: 'high',
                    // 混合形态：字符串 = 继承全局；对象 = 显式档位。
                    baseUrls: ['https://a.com/api', { url: 'https://b.com', level: 'max' }]
                },
                systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: { enabled: false, ratio: 1, baseUrls: [] }
            }
        });
    });
    await flushPageMicrotasks();

    const rows = page.elements.effortTargetList.children;
    assert.equal(rows.length, 2);
    // 每行含档位下拉：1 个「继承全局」+ 6 档。
    const firstLevel = rows[0].options[1];
    assert.equal(firstLevel.options.length, 7);
    assert.equal(firstLevel.options[0].value, '');
    assert.equal(firstLevel.options[0].textContent, '继承全局');
    assert.deepEqual(
        firstLevel.options.slice(1).map((option) => option.value),
        ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
    );
    // 字符串条目 → 继承全局（空值）；对象条目 → 预选其档位。
    assert.equal(firstLevel.value, '');
    assert.equal(rows[1].options[1].value, 'max');
    // usageScale 列表无档位下拉（行元素仅 [input, 删除按钮]）。
    assert.equal(page.elements.scaleTargetList.children.length, 0);
});

test('page script: effort level change submits object form; empty submits string form', async (t) => {
    const patched = [];
    const page = createPageHarness(({ url, options }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/captured-system-prompt') {
            return pageJsonResponse(200, { ok: true, data: { prompt: null } });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (options.method === 'PATCH') {
            const body = JSON.parse(options.body);
            patched.push(body);
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: {
                        enabled: true, level: 'high', baseUrls: body.value
                    },
                    systemPromptOverride: { enabled: false, prompt: '' },
                    usageScale: { enabled: false, ratio: 1, baseUrls: [] }
                }
            });
        }
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: {
                    enabled: true, level: 'high',
                    baseUrls: ['https://a.com', { url: 'https://b.com', level: 'low' }]
                },
                systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: { enabled: false, ratio: 1, baseUrls: [] }
            }
        });
    });
    await flushPageMicrotasks();
    assert.equal(patched.length, 0);

    // 第二行档位由 low 改为 max：change 触发全量提交，该项转为对象形态。
    const level = page.elements.effortTargetList.children[1].options[1];
    level.value = 'max';
    await level.dispatch('change');
    await flushPageMicrotasks();
    assert.equal(patched.length, 1);
    assert.equal(patched[0].key, 'effortOverride.baseUrls');
    assert.deepEqual(patched[0].value, ['https://a.com', { url: 'https://b.com', level: 'max' }]);

    // 首行档位选回「继承全局」（空值）：该项退回纯字符串形态。
    const firstLevel = page.elements.effortTargetList.children[0].options[1];
    firstLevel.value = 'ultracode';
    await firstLevel.dispatch('change');
    await flushPageMicrotasks();
    assert.deepEqual(patched[1].value,
        [{ url: 'https://a.com', level: 'ultracode' }, { url: 'https://b.com', level: 'max' }]);
});

test('page script: usageScale target rows have no level select', async (t) => {
    const page = createPageHarness(({ url, options }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/captured-system-prompt') {
            return pageJsonResponse(200, { ok: true, data: { prompt: null } });
        }
        if (url === '/api/session') return pageSessionResponse();
        if (options.method === 'PATCH') return pageJsonResponse(200, { ok: true, data: {} });
        return pageJsonResponse(200, {
            ok: true,
            data: {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high', baseUrls: [] },
                systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: { enabled: true, ratio: 0.5, baseUrls: ['https://a.com'] }
            }
        });
    });
    await flushPageMicrotasks();

    const row = page.elements.scaleTargetList.children[0];
    // 仅 [URL input, 删除按钮] 两个子元素，删除按钮位于 options[1]。
    assert.equal(row.options.length, 2);
    assert.equal(row.options[0].className, 'target-url');
    assert.equal(row.options[1].className, 'target-remove');
});

async function startApi({
    read,
    write,
    envDir,
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
        envDir,
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
            effortOverride: { enabled: true, level: 'high', baseUrls: [] },
            systemPromptOverride: { enabled: false, prompt: '' },
            usageScale: { enabled: false, ratio: 1, baseUrls: [] }
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
            effortOverride: { enabled: true, level: 'high', baseUrls: [] },
            systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: { enabled: false, ratio: 1, baseUrls: [] }
        });

        const configFile = path.join(envDir, 'config.json');
        assert.deepEqual(
            JSON.parse(fs.readFileSync(configFile, 'utf8')),
            {
                thinkingWindow: { enabled: false, lines: 10 },
                forwardSuggestionMode: true,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high', baseUrls: [] },
                systemPromptOverride: { enabled: false, prompt: '' },
                    usageScale: { enabled: false, ratio: 1, baseUrls: [] },
                alerts: { dailyTokens: 0, dailyCost: 0 },
                usageAlert: { warnThreshold: 0.8, limitThreshold: 1 },
                models: {},
                upstreams: []
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
            systemPromptOverride: { enabled: false, prompt: '' },
            usageScale: { enabled: false, ratio: 1, baseUrls: [] }
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
            systemPromptOverride: { enabled: false, prompt: '' },
            usageScale: { enabled: false, ratio: 1, baseUrls: [] }
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

test('API: PATCH usageScale writes enabled and ratio, invalid ratio rejected', async (t) => {
    let update = null;
    let writes = 0;
    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            effortOverride: { enabled: true, level: 'high' },
            systemPromptOverride: { enabled: false, prompt: '' },
            usageScale: { enabled: false, ratio: 1, baseUrls: [] }
        }),
        write: (partial) => {
            update = partial;
            writes += 1;
            return {
                forwardSuggestionMode: false,
                thinkingAsText: true,
                effortOverride: { enabled: true, level: 'high' },
                systemPromptOverride: { enabled: false, prompt: '' },
                usageScale: { enabled: true, ratio: 0.5 }
            };
        }
    });
    t.after(api.close);

    const ratioPatch = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'usageScale.ratio', value: 0.5 })
    });
    assert.equal(ratioPatch.status, 200);
    assert.deepEqual(update, { usageScale: { ratio: 0.5 } });
    assert.deepEqual((await ratioPatch.json()).data.usageScale, { enabled: true, ratio: 0.5 });

    const enabledPatch = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'usageScale.enabled', value: true })
    });
    assert.equal(enabledPatch.status, 200);
    assert.deepEqual(update, { usageScale: { enabled: true } });

    const writesBefore = writes;
    for (const body of [
        // ratio 非法：0 / 负数 / 越界 >10 / NaN / 非数值 / 布尔。
        JSON.stringify({ key: 'usageScale.ratio', value: 0 }),
        JSON.stringify({ key: 'usageScale.ratio', value: -0.5 }),
        JSON.stringify({ key: 'usageScale.ratio', value: 10.1 }),
        JSON.stringify({ key: 'usageScale.ratio', value: NaN }),
        JSON.stringify({ key: 'usageScale.ratio', value: '0.5' }),
        JSON.stringify({ key: 'usageScale.ratio', value: true }),
        // enabled 非布尔。
        JSON.stringify({ key: 'usageScale.enabled', value: 1 })
    ]) {
        const response = await fetch(`${api.origin}/api/settings`, {
            method: 'PATCH',
            headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
            body
        });
        assert.equal(response.status, 400, body);
    }
    assert.equal(writes, writesBefore);
    const baseUrlsPatch = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'usageScale.baseUrls', value: ['https://a.com/api', 'http://b.com:8080'] })
    });
    assert.equal(baseUrlsPatch.status, 200);
    assert.deepEqual(update, { usageScale: { baseUrls: ['https://a.com/api', 'http://b.com:8080'] } });
    // 空数组 = 清空定向列表（等效全量缩放），须合法。
    const emptyPatch = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'usageScale.baseUrls', value: [] })
    });
    assert.equal(emptyPatch.status, 200);
    assert.deepEqual(update, { usageScale: { baseUrls: [] } });
});

test('API: PATCH usageScale.baseUrls trims whitespace before write', async (t) => {
    let update = null;
    const api = await startApi({
        read: () => ({ usageScale: { enabled: true, ratio: 0.5, baseUrls: [] } }),
        write: (partial) => {
            update = partial;
            return {};
        }
    });
    t.after(api.close);

    const response = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'usageScale.baseUrls', value: ['  https://a.com/api  '] })
    });
    assert.equal(response.status, 200);
    // 校验与落盘同口径：边界处 trim 后交给 writeConfig。
    assert.deepEqual(update, { usageScale: { baseUrls: ['https://a.com/api'] } });
});

test('API: PATCH usageScale.baseUrls invalid array rejected with 400', async (t) => {
    let writes = 0;
    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            effortOverride: { enabled: true, level: 'high' },
            systemPromptOverride: { enabled: false, prompt: '' },
            usageScale: { enabled: false, ratio: 1, baseUrls: [] }
        }),
        write: () => {
            writes += 1;
            return {};
        }
    });
    t.after(api.close);

    for (const body of [
        // 非数组。
        JSON.stringify({ key: 'usageScale.baseUrls', value: 'https://a.com' }),
        JSON.stringify({ key: 'usageScale.baseUrls', value: null }),
        // 含非字符串 / 空串 / 不可解析 / 非 http(s) 协议项：任一非法整次 400。
        JSON.stringify({ key: 'usageScale.baseUrls', value: ['https://a.com', 42] }),
        JSON.stringify({ key: 'usageScale.baseUrls', value: ['https://a.com', ''] }),
        JSON.stringify({ key: 'usageScale.baseUrls', value: ['not a url'] }),
        JSON.stringify({ key: 'usageScale.baseUrls', value: ['ftp://a.com'] })
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

test('API: PATCH effortOverride.baseUrls writes trimmed array, invalid rejected', async (t) => {
    let update = null;
    let writes = 0;
    const api = await startApi({
        read: () => ({
            effortOverride: { enabled: true, level: 'high', baseUrls: [] }
        }),
        write: (partial) => {
            update = partial;
            writes += 1;
            return {};
        }
    });
    t.after(api.close);

    const valid = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'effortOverride.baseUrls', value: [' https://a.com/api ', 'http://b.com:8080'] })
    });
    assert.equal(valid.status, 200);
    // 边界处统一 trim 后交给 writeConfig（与 usageScale.baseUrls 同口径）。
    assert.deepEqual(update, {
        effortOverride: { baseUrls: ['https://a.com/api', 'http://b.com:8080'] }
    });

    // 空数组 = 清空定向列表（等效全量覆写），须合法。
    const empty = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: 'effortOverride.baseUrls', value: [] })
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(update, { effortOverride: { baseUrls: [] } });

    const writesBefore = writes;
    for (const body of [
        // 非数组。
        JSON.stringify({ key: 'effortOverride.baseUrls', value: 'https://a.com' }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: null }),
        // 含非字符串 / 空串 / 不可解析 / 非 http(s) 协议项：任一非法整次 400。
        JSON.stringify({ key: 'effortOverride.baseUrls', value: ['https://a.com', 42] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: ['https://a.com', ''] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: ['   '] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: ['not a url'] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: ['ftp://a.com'] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [null] })
    ]) {
        const response = await fetch(`${api.origin}/api/settings`, {
            method: 'PATCH',
            headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
            body
        });
        assert.equal(response.status, 400, body);
    }
    assert.equal(writes, writesBefore);
});

test('API: PATCH effortOverride.baseUrls accepts mixed string / object entries', async (t) => {
    let update = null;
    const api = await startApi({
        read: () => ({ effortOverride: { enabled: true, level: 'high', baseUrls: [] } }),
        write: (partial) => {
            update = partial;
            return {};
        }
    });
    t.after(api.close);

    const response = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            key: 'effortOverride.baseUrls',
            value: [
                ' https://a.com ',
                { url: ' https://b.com ', level: 'max' },
                // level 缺失：对象项只保留 url 键（丢弃 undefined 空档位字段）。
                { url: 'https://c.com' }
            ]
        })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(update, {
        effortOverride: {
            baseUrls: [
                'https://a.com',
                { url: 'https://b.com', level: 'max' },
                { url: 'https://c.com' }
            ]
        }
    });

    // 边界归一后经 settings.js 层去重：尾斜杠归一为同一 URL，保留首项形态。
    const dedupe = await fetch(`${api.origin}/api/settings`, {
        method: 'PATCH',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            key: 'effortOverride.baseUrls',
            value: ['https://a.com', { url: 'https://a.com/', level: 'max' }]
        })
    });
    assert.equal(dedupe.status, 200);
    assert.deepEqual(update.effortOverride.baseUrls,
        ['https://a.com', { url: 'https://a.com/', level: 'max' }]);
});

test('API: PATCH effortOverride.baseUrls rejects invalid mixed entry shapes with 400', async (t) => {
    let writes = 0;
    const api = await startApi({
        read: () => ({ effortOverride: { enabled: true, level: 'high', baseUrls: [] } }),
        write: () => {
            writes += 1;
            return {};
        }
    });
    t.after(api.close);

    for (const body of [
        // 项为非字符串非对象（数组亦不接受）。
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [[{ url: 'https://a.com' }]] }),
        // 对象缺 url / url 非法 / url 非字符串。
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [{ level: 'max' }] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [{ url: 'not a url' }] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [{ url: 42 }] }),
        // url 非 http(s) 协议。
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [{ url: 'ftp://a.com' }] }),
        // level 存在但非枚举（含 null 与大小写不同）。
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [{ url: 'https://a.com', level: 'bogus' }] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [{ url: 'https://a.com', level: null }] }),
        JSON.stringify({ key: 'effortOverride.baseUrls', value: [{ url: 'https://a.com', level: 'HIGH' }] })
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

test('API: GET /api/upstream-health returns snapshot, empty fallback and 405', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-health-api-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const healthFile = path.join(home, '.cc-proxy', 'runtime', 'upstream-health.json');
    const realHomedir = os.homedir;
    os.homedir = () => home;
    t.after(() => { os.homedir = realHomedir; });

    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    // 缺失文件：返回空快照而非报错。
    const missing = await fetch(`${api.origin}/api/upstream-health`, { headers: authHeaders(api) });
    assert.equal(missing.status, 200);
    const missingBody = await missing.json();
    assert.equal(missingBody.ok, true);
    assert.deepEqual(missingBody.data, { updatedAt: null, upstreams: [], failovers: [] });

    // 落盘快照：原样读回（只读不缓存，每次请求重读文件）。
    fs.mkdirSync(path.dirname(healthFile), { recursive: true });
    const snapshot = {
        updatedAt: '2026-10-15T08:00:00.000Z',
        upstreams: [{
            id: 'api.anthropic.com',
            requests: 4, failures: 1,
            ttftP50: 120, ttftP95: 480, samples: 3,
            breaker: { state: 'closed', consecutiveFailures: 0, cooldownRemainingMs: 0 }
        }],
        failovers: [{ time: '2026-10-15T08:00:00.000Z', from: 'a', to: 'b', reason: 'HTTP 429' }]
    };
    fs.writeFileSync(healthFile, JSON.stringify(snapshot));
    const ok = await fetch(`${api.origin}/api/upstream-health`, { headers: authHeaders(api) });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.deepEqual(okBody.data, snapshot);

    // 损坏文件：回退空快照。
    fs.writeFileSync(healthFile, '{not json');
    const corrupt = await fetch(`${api.origin}/api/upstream-health`, { headers: authHeaders(api) });
    assert.deepEqual((await corrupt.json()).data, { updatedAt: null, upstreams: [], failovers: [] });

    // 非 GET：405 + Allow。
    const post = await fetch(`${api.origin}/api/upstream-health`, {
        method: 'POST',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: '{}'
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');

    // 无 token：401（认证链在 handler 之前统一执行）。
    const unauthorized = await fetch(`${api.origin}/api/upstream-health`);
    assert.equal(unauthorized.status, 401);
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

test('API: GET /api/usage returns 30-day usage report', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-usage-api-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const usageFile = path.join(home, '.cc-proxy', 'usage.json');
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });
    const dayKey = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() - offset);
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    };
    // 今日两条模型用量 + 3 天前旧格式（无 byModel）兼容数据。
    fs.writeFileSync(usageFile, JSON.stringify({
        [dayKey(0)]: {
            requests: 2,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 40,
            cacheCreationTokens: 10,
            byModel: {
                'claude-sonnet-5': {
                    requests: 2, inputTokens: 100,
                    outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 10
                }
            }
        },
        [dayKey(3)]: { requests: 1, inputTokens: 10, outputTokens: 5 }
    }));
    const realHomedir = os.homedir;
    os.homedir = () => home;
    t.after(() => { os.homedir = realHomedir; });

    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            alerts: { dailyTokens: 0 },
            models: {}
        }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    const res = await fetch(`${api.origin}/api/usage`, { headers: authHeaders(api) });
    assert.equal(res.status, 200);
    const { ok, data } = await res.json();
    assert.equal(ok, true);
    assert.equal(data.days.length, 30);
    const today = data.days[0];
    assert.equal(today.date, dayKey(0));
    assert.equal(today.requests, 2);
    assert.equal(today.totalTokens, 200);
    // 命中率 = cacheRead / (cacheRead + cacheCreation + input) = 40/150。
    assert.ok(Math.abs(today.hitRate - 40 / 150) < 1e-9);
    // claude-sonnet-5 有定价：(100*3 + 50*15 + 40*0.3 + 10*3.75) / 1e6。
    const expectedCost = (100 * 3 + 50 * 15 + 40 * 0.3 + 10 * 3.75) / 1e6;
    assert.ok(Math.abs(today.cost - expectedCost) < 1e-12);
    assert.equal(today.byModel['claude-sonnet-5'].requests, 2);

    // 3 天前旧格式条目：byModel 回退空，无模型则 cost 为 null。
    const older = data.days[3];
    assert.equal(older.date, dayKey(3));
    assert.equal(older.requests, 1);
    assert.equal(older.cost, null);

    // 无用量的日子：hitRate/cost 均为 null。
    const empty = data.days[1];
    assert.equal(empty.requests, 0);
    assert.equal(empty.hitRate, null);
    assert.equal(empty.cost, null);

    // 告警未配置（0）：不判超限。
    assert.deepEqual(data.alert, { dailyTokens: 0, dailyCost: 0, level: 'none', exceeded: false, ratio: 0 });
});

test('API: /api/usage alert exceeded when threshold configured', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-usage-alert-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const usageFile = path.join(home, '.cc-proxy', 'usage.json');
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    fs.writeFileSync(usageFile, JSON.stringify({
        [`${d.getFullYear()}-${m}-${day}`]: {
            requests: 1, inputTokens: 500, outputTokens: 0
        }
    }));
    const realHomedir = os.homedir;
    os.homedir = () => home;
    t.after(() => { os.homedir = realHomedir; });

    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            alerts: { dailyTokens: 100 },
            models: {}
        }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    const res = await fetch(`${api.origin}/api/usage`, { headers: authHeaders(api) });
    const { data } = await res.json();
    assert.deepEqual(data.alert, { dailyTokens: 100, dailyCost: 0, level: 'limit', exceeded: true, ratio: 5 });
});

test('API: GET /api/usage/export supports csv and json, rejects unknown format', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-usage-export-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const usageFile = path.join(home, '.cc-proxy', 'usage.json');
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });
    const dayKey = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() - offset);
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    };
    // 今日 claude-sonnet-5 可定价 + 昨日无模型（cost 为 null → CSV 空列）。
    fs.writeFileSync(usageFile, JSON.stringify({
        [dayKey(0)]: {
            requests: 2, inputTokens: 100, outputTokens: 50,
            cacheReadTokens: 40, cacheCreationTokens: 10,
            byModel: {
                'claude-sonnet-5': {
                    requests: 2, inputTokens: 100,
                    outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 10
                }
            }
        },
        [dayKey(1)]: { requests: 1, inputTokens: 10, outputTokens: 5 }
    }));
    const realHomedir = os.homedir;
    os.homedir = () => home;
    t.after(() => { os.homedir = realHomedir; });

    const api = await startApi({
        read: () => ({
            forwardSuggestionMode: false,
            thinkingAsText: true,
            alerts: { dailyTokens: 0 },
            models: {}
        }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    // CSV：表头 + 30 行（近 30 天每天一行，含无数据日）。
    const csvRes = await fetch(
        `${api.origin}/api/usage/export?format=csv`,
        { headers: authHeaders(api) }
    );
    assert.equal(csvRes.status, 200);
    assert.ok(
        csvRes.headers.get('content-type').startsWith('text/csv')
    );
    const csvText = await csvRes.text();
    const csvLines = csvText.trimEnd().split('\n');
    assert.equal(csvLines.length, 31);
    assert.equal(
        csvLines[0],
        'date,requests,inputTokens,outputTokens,'
            + 'cacheReadTokens,cacheCreationTokens,cost'
    );
    // cost 列经 estimateCost 逐维度累加，存在浮点尾差，按数值近似比较。
    const expectedCost = (100 * 3 + 50 * 15 + 40 * 0.3 + 10 * 3.75) / 1e6;
    const todayCells = csvLines[1].split(',');
    assert.deepEqual(
        todayCells.slice(0, 6),
        [dayKey(0), '2', '100', '50', '40', '10']
    );
    assert.ok(Math.abs(Number(todayCells[6]) - expectedCost) < 1e-12);
    assert.equal(csvLines[2], `${dayKey(1)},1,10,5,0,0,`);

    // JSON：与 /api/usage 数据结构一致。
    const jsonRes = await fetch(
        `${api.origin}/api/usage/export?format=json`,
        { headers: authHeaders(api) }
    );
    assert.equal(jsonRes.status, 200);
    assert.ok(
        jsonRes.headers.get('content-type').startsWith('application/json')
    );
    const exportBody = await jsonRes.json();
    const usageRes = await fetch(`${api.origin}/api/usage`, {
        headers: authHeaders(api)
    });
    const usageBody = await usageRes.json();
    assert.deepEqual(exportBody, usageBody);

    // 未知 format → 400。
    const badRes = await fetch(
        `${api.origin}/api/usage/export?format=xml`,
        { headers: authHeaders(api) }
    );
    assert.equal(badRes.status, 400);
    const noFormatRes = await fetch(
        `${api.origin}/api/usage/export`,
        { headers: authHeaders(api) }
    );
    assert.equal(noFormatRes.status, 400);

    // 非 GET → 405。
    const postRes = await fetch(
        `${api.origin}/api/usage/export?format=csv`,
        { method: 'POST', headers: authHeaders(api) }
    );
    assert.equal(postRes.status, 405);
});

test('page script: renderUsageBoard renders bars, summary and per-model table', async () => {
    const page = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/usage') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    days: [
                        {
                            date: '2026-10-15', requests: 2, totalTokens: 500,
                            inputTokens: 200, outputTokens: 250,
                            cacheReadTokens: 200, cacheCreationTokens: 50,
                            hitRate: 0.5, cost: 1.25,
                            byModel: { 'claude-sonnet-5': { requests: 2 } }
                        },
                        {
                            date: '2026-10-14', requests: 1, totalTokens: 200,
                            inputTokens: 100, outputTokens: 100,
                            cacheReadTokens: 0, cacheCreationTokens: 0,
                            hitRate: null, cost: 0.75, byModel: {}
                        }
                    ],
                    alert: { dailyTokens: 1000, exceeded: true }
                }
            });
        }
        if (url === '/api/settings') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: false, level: 'standard' }
                }
            });
        }
        if (url === '/api/upstream-health') {
            return pageJsonResponse(200, { ok: true, data: { upstreams: [], failovers: [] } });
        }
        if (url === '/api/recent-requests') {
            return pageJsonResponse(200, { ok: true, data: { updatedAt: null, entries: [] } });
        }
        if (url === '/api/session') return pageSessionResponse();
        throw new Error(`unexpected request: ${url}`);
    });
    await flushPageMicrotasks();

    const board = page.elements.usageBoard;
    // Tab 条：三个 Tab，今日默认高亮。
    const tabs = board.options.find((el) => el.className === 'usage-tabs');
    assert.ok(tabs);
    assert.equal(tabs.options.length, 3);
    assert.deepEqual(tabs.options.map((t) => t.textContent), ['今日', '七天', '一个月']);
    assert.equal(tabs.options[0].className, 'usage-tab active');
    assert.equal(tabs.options[1].className, 'usage-tab');
    // 柱状图：今日 Tab 下 1 根柱，超阈值红柱。
    const bars = board.options.find((el) => el.className === 'usage-bars');
    assert.ok(bars);
    assert.equal(bars.options.length, 1);
    const todayBar = bars.options[0];
    const todayFill = todayBar.options[0];
    assert.ok(todayFill.className.includes('alert'));
    assert.equal(todayFill.style.height, '100%');
    assert.equal(todayBar.options[1].textContent, '10-15');

    // 汇总行：红点 + 今日 tokens/命中率/费用文本。
    const summary = board.options.find((el) => el.className === 'usage-summary');
    assert.ok(summary);
    assert.equal(summary.options[0].className, 'alert-dot');
    assert.match(
        String(summary.options[1].textContent),
        /今日用量已超限/
    );
    assert.match(
        String(summary.options[2].textContent),
        /今日 500 tokens · 命中率 50\.0% · 费用 \$1\.25/
    );

    // 按模型表：表头 + 模型名经 textContent 渲染。
    const table = board.options.find((el) => el.className === 'usage-table');
    assert.ok(table);
    assert.deepEqual(
        table.options[0].options.map((th) => th.textContent),
        ['模型', '请求', '输入', '输出', '缓存读', '缓存写']
    );
    assert.equal(table.options[1].options[0].textContent, 'claude-sonnet-5');

    // 切到七天 Tab：2 根柱 + 区间聚合汇总（cost 逐日可估时求和 1.25+0.75=2.00）。
    // 注：harness 的 options 不随 textContent='' 清空，重渲染后取最后一次追加的同名节点。
    await tabs.options[1].dispatch('click');
    await flushPageMicrotasks();
    const weekBars = board.options.filter((el) => el.className === 'usage-bars').pop();
    assert.equal(weekBars.options.length, 2);
    const weekSummary = board.options.filter((el) => el.className === 'usage-summary').pop();
    assert.ok(weekSummary);
    assert.match(
        String(weekSummary.options[2].textContent),
        /七天 900 tokens · 命中率 36\.4% · 费用 \$2\.00/
    );

    // 切到一个月 Tab：柱数按实际天数（此处 2 天），聚合口径与七天一致。
    await tabs.options[2].dispatch('click');
    await flushPageMicrotasks();
    const monthBars = board.options.filter((el) => el.className === 'usage-bars').pop();
    assert.equal(monthBars.options.length, 2);
    const monthSummary = board.options.filter((el) => el.className === 'usage-summary').pop();
    assert.match(String(monthSummary.options[2].textContent), /一个月 900 tokens/);

    // 导出按钮行：两个入口恒在渲染（与 Tab/数据无关）。
    const exportRow = board.options.filter((el) => el.className === 'usage-export').pop();
    assert.ok(exportRow);
    assert.deepEqual(exportRow.options.map((btn) => btn.textContent), ['导出 CSV', '导出 JSON']);
});

test('page script: usage alert warn level renders yellow bar, dot and ratio', async () => {
    const page = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/usage') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    days: [
                        {
                            date: '2026-10-15', requests: 1, totalTokens: 820,
                            inputTokens: 820, outputTokens: 0,
                            cacheReadTokens: 0, cacheCreationTokens: 0,
                            hitRate: null, cost: null, byModel: {}
                        }
                    ],
                    alert: { dailyTokens: 1000, dailyCost: 0, level: 'warn', exceeded: false, ratio: 0.82 }
                }
            });
        }
        if (url === '/api/settings') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: false, level: 'standard' }
                }
            });
        }
        if (url === '/api/upstream-health') {
            return pageJsonResponse(200, { ok: true, data: { upstreams: [], failovers: [] } });
        }
        if (url === '/api/recent-requests') {
            return pageJsonResponse(200, { ok: true, data: { updatedAt: null, entries: [] } });
        }
        if (url === '/api/session') return pageSessionResponse();
        throw new Error(`unexpected request: ${url}`);
    });
    await flushPageMicrotasks();

    const board = page.elements.usageBoard;
    // 今日柱：warn 级黄柱（含 warn 不含 alert）。
    const bars = board.options.find((el) => el.className === 'usage-bars');
    const todayFill = bars.options[0].options[0];
    assert.ok(todayFill.className.includes('warn'));
    assert.ok(!todayFill.className.includes('alert'));
    // 汇总行：黄点（warn 类）+ 预警文案 + 已用 82%。
    const summary = board.options.find((el) => el.className === 'usage-summary');
    const dot = summary.options[0];
    assert.equal(dot.className, 'alert-dot warn');
    assert.equal(dot.attributes['aria-label'], '今日用量预警');
    assert.match(String(summary.options[1].textContent), /今日用量预警 · 已用 82% · /);
    // 导出按钮行恒在。
    assert.ok(board.options.find((el) => el.className === 'usage-export'));
});

test('page script: export buttons fetch with token and trigger download', async () => {
    const page = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/usage') {
            return pageJsonResponse(200, {
                ok: true,
                data: { days: [], alert: { dailyTokens: 0, level: 'none', exceeded: false, ratio: 0 } }
            });
        }
        if (url === '/api/settings') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: false, level: 'standard' }
                }
            });
        }
        if (url.startsWith('/api/usage/export')) {
            return {
                ok: true,
                blob: async () => 'BLOB',
                json: async () => { throw new Error('no json'); }
            };
        }
        if (url === '/api/upstream-health') {
            return pageJsonResponse(200, { ok: true, data: { upstreams: [], failovers: [] } });
        }
        if (url === '/api/recent-requests') {
            return pageJsonResponse(200, { ok: true, data: { updatedAt: null, entries: [] } });
        }
        if (url === '/api/session') return pageSessionResponse();
        throw new Error(`unexpected request: ${url}`);
    });
    await flushPageMicrotasks();

    const board = page.elements.usageBoard;
    // 空数据也渲染导出行（导出近 30 天不依赖当日有数据）。
    const exportRow = board.options.find((el) => el.className === 'usage-export');
    assert.ok(exportRow);
    assert.deepEqual(exportRow.options.map((btn) => btn.textContent), ['导出 CSV', '导出 JSON']);

    // 点击 CSV：带 token 请求导出接口 → blob URL → <a download> 点击 → 立即 revoke。
    await exportRow.options[0].dispatch('click');
    await flushPageMicrotasks();
    const exportCall = page.calls.find((call) => call.url.startsWith('/api/usage/export'));
    assert.ok(exportCall);
    assert.equal(exportCall.url, '/api/usage/export?format=csv');
    assert.equal(exportCall.options.headers['X-CC-Proxy-Token'], 'vm-token');
    assert.equal(page.objectUrls.length, 1);
    assert.equal(page.objectUrls[0].blob, 'BLOB');
    const link = page.created.find((el) => el.download === 'cc-proxy-usage.csv');
    assert.ok(link);
    assert.equal(link.clicked, true);
    // revoke 推迟到宏任务：flush 微任务后尚未执行，轮转宏任务队列后才释放。
    assert.deepEqual(page.revokedUrls, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(page.revokedUrls, [page.objectUrls[0].url]);

    // 点击 JSON：同链路，文件名随格式变化。
    await exportRow.options[1].dispatch('click');
    await flushPageMicrotasks();
    const jsonCall = page.calls.filter((call) => call.url.startsWith('/api/usage/export')).pop();
    assert.equal(jsonCall.url, '/api/usage/export?format=json');
    assert.ok(page.created.find((el) => el.download === 'cc-proxy-usage.json'));

    // 失败分支：接口非 2xx → 状态条报错且不创建 blob URL。
    const failing = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/usage') {
            return pageJsonResponse(200, {
                ok: true,
                data: { days: [], alert: { dailyTokens: 0, level: 'none', exceeded: false, ratio: 0 } }
            });
        }
        if (url === '/api/settings') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: false, level: 'standard' }
                }
            });
        }
        if (url.startsWith('/api/usage/export')) return pageJsonResponse(500, { ok: false });
        if (url === '/api/upstream-health') {
            return pageJsonResponse(200, { ok: true, data: { upstreams: [], failovers: [] } });
        }
        if (url === '/api/recent-requests') {
            return pageJsonResponse(200, { ok: true, data: { updatedAt: null, entries: [] } });
        }
        if (url === '/api/session') return pageSessionResponse();
        throw new Error(`unexpected request: ${url}`);
    });
    await flushPageMicrotasks();
    const failingRow = failing.elements.usageBoard.options.find((el) => el.className === 'usage-export');
    await failingRow.options[0].dispatch('click');
    await flushPageMicrotasks();
    assert.equal(failing.elements.status.textContent, '用量导出失败');
    assert.ok(failing.elements.status.classList.contains('error'));
    assert.equal(failing.objectUrls.length, 0);

    // blob() 抛错分支：同样走 catch 报错且不创建 blob URL。
    const blobThrowing = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/usage') {
            return pageJsonResponse(200, {
                ok: true,
                data: { days: [], alert: { dailyTokens: 0, level: 'none', exceeded: false, ratio: 0 } }
            });
        }
        if (url === '/api/settings') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: false, level: 'standard' }
                }
            });
        }
        if (url.startsWith('/api/usage/export')) {
            return { ok: true, blob: async () => { throw new Error('boom'); } };
        }
        if (url === '/api/upstream-health') {
            return pageJsonResponse(200, { ok: true, data: { upstreams: [], failovers: [] } });
        }
        if (url === '/api/recent-requests') {
            return pageJsonResponse(200, { ok: true, data: { updatedAt: null, entries: [] } });
        }
        if (url === '/api/session') return pageSessionResponse();
        throw new Error(`unexpected request: ${url}`);
    });
    await flushPageMicrotasks();
    const throwingRow = blobThrowing.elements.usageBoard.options.find((el) => el.className === 'usage-export');
    await throwingRow.options[0].dispatch('click');
    await flushPageMicrotasks();
    assert.equal(blobThrowing.elements.status.textContent, '用量导出失败');
    assert.equal(blobThrowing.objectUrls.length, 0);
});

test('page script: renderUpstreamHealth shows breaker badges per state', async () => {
    const page = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/usage') {
            return pageJsonResponse(200, {
                ok: true,
                data: { days: [], alert: { dailyTokens: 0, exceeded: false } }
            });
        }
        if (url === '/api/upstream-health') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    upstreams: [
                        // closed：不展示徽标。
                        { id: 'closed-up', requests: 4, failures: 0, ttftP50: 100, ttftP95: 200,
                            breaker: { state: 'closed', consecutiveFailures: 0, cooldownRemainingMs: 0 } },
                        // open：展示「熔断中」+ 剩余秒数（向上取整）。
                        { id: 'open-up', requests: 4, failures: 4, ttftP50: null, ttftP95: null,
                            breaker: { state: 'open', consecutiveFailures: 3, cooldownRemainingMs: 12500 } },
                        // half-open：展示「半开探测」。
                        { id: 'half-up', requests: 4, failures: 3, ttftP50: 90, ttftP95: 180,
                            breaker: { state: 'half-open', consecutiveFailures: 3, cooldownRemainingMs: 0 } },
                        // 旧快照无 breaker 字段：按 closed 容错，不展示徽标。
                        { id: 'legacy-up', requests: 2, failures: 0, ttftP50: 80, ttftP95: 160 }
                    ],
                    failovers: []
                }
            });
        }
        if (url === '/api/recent-requests') {
            return pageJsonResponse(200, { ok: true, data: { updatedAt: null, entries: [] } });
        }
        if (url === '/api/settings') {
            return pageJsonResponse(200, {
                ok: true,
                data: { forwardSuggestionMode: false, thinkingAsText: true }
            });
        }
        if (url === '/api/session') return pageSessionResponse();
        throw new Error(`unexpected request: ${url}`);
    });
    await flushPageMicrotasks();

    const board = page.elements.healthBoard;
    const rows = board.options.filter((el) => el.className === 'usage-summary');
    assert.equal(rows.length, 4);
    // closed 行：仅文本节点，无徽标 span。
    assert.equal(rows[0].options.length, 1);
    assert.match(String(rows[0].options[0].textContent), /closed-up · 成功率 100\.0%/);
    // open 行：红色徽标「熔断中（剩余 13s）」——12500ms 向上取整为 13s。
    const openBadge = rows[1].options[1];
    assert.equal(openBadge.className, 'breaker-badge breaker-open');
    assert.equal(openBadge.textContent, '熔断中（剩余 13s）');
    // half-open 行：黄色徽标「半开探测」。
    const halfBadge = rows[2].options[1];
    assert.equal(halfBadge.className, 'breaker-badge breaker-half-open');
    assert.equal(halfBadge.textContent, '半开探测');
    // 无 breaker 字段的旧行：无徽标。
    assert.equal(rows[3].options.length, 1);
});

test('page script: renderRecentRequests renders rows, flags and toggle detail', async () => {
    const entries = [
        {
            time: '2026-10-15T08:00:00.000Z', statusCode: 200,
            upstream: 'primary', model: 'claude-sonnet-5',
            ttftMs: 850, thinkingRewritten: true, failedOver: true,
            requestHeaders: { 'x-api-key': '[REDACTED]' },
            responseHeaders: { 'content-type': 'text/event-stream' }
        },
        {
            time: '2026-10-15T07:59:00.000Z', statusCode: null,
            upstream: 'primary', model: null,
            ttftMs: null, requestHeaders: null, responseHeaders: null
        }
    ];
    const page = createPageHarness(({ url }) => {
        if (url === '/api/bootstrap') {
            return pageJsonResponse(200, { ok: true, data: { token: 'vm-token' } });
        }
        if (url === '/api/usage') {
            return pageJsonResponse(200, {
                ok: true,
                data: { days: [], alert: { dailyTokens: 0, level: 'none', exceeded: false, ratio: 0 } }
            });
        }
        if (url === '/api/settings') {
            return pageJsonResponse(200, {
                ok: true,
                data: {
                    forwardSuggestionMode: false,
                    thinkingAsText: true,
                    effortOverride: { enabled: false, level: 'standard' }
                }
            });
        }
        if (url === '/api/upstream-health') {
            return pageJsonResponse(200, { ok: true, data: { upstreams: [], failovers: [] } });
        }
        if (url === '/api/recent-requests') {
            return pageJsonResponse(200, { ok: true, data: { updatedAt: null, entries } });
        }
        if (url === '/api/session') return pageSessionResponse();
        throw new Error(`unexpected request: ${url}`);
    });
    await flushPageMicrotasks();

    const board = page.elements.recentRequestsBoard;
    // 表头：六列；最新在前（entry[0] 为首条数据行）。
    const table = board.options.find((el) => el.className === 'usage-table');
    assert.ok(table);
    assert.deepEqual(
        table.options[0].options.map((th) => th.textContent),
        ['时间', '状态', '上游', '模型', 'TTFT', '标记']
    );
    const first = table.options[1];
    assert.equal(first.options.length, 6);
    // 倒序展示：entries.reverse() 后首条数据行为原数组末项（07:59 失败请求）。
    // 期望时间从同一 Date 动态生成本地字段，非 UTC+8 时区也能通过。
    const expectedTs = new Date('2026-10-15T07:59:00.000Z');
    const pad2 = (n) => String(n).padStart(2, '0');
    const expectedTime = `${pad2(expectedTs.getMonth() + 1)}-${pad2(expectedTs.getDate())} `
        + `${pad2(expectedTs.getHours())}:${pad2(expectedTs.getMinutes())}:${pad2(expectedTs.getSeconds())}`;
    assert.equal(first.options[0].textContent, expectedTime);
    assert.equal(first.options[1].textContent, '失败');
    assert.equal(first.options[2].textContent, 'primary');
    assert.equal(first.options[3].textContent, '');
    assert.equal(first.options[4].textContent, 'n/a');
    assert.equal(first.options[5].textContent, '');
    // 第二行：成功请求，含 💭/⇄ 标记。
    const second = table.options[2];
    assert.equal(second.options[1].textContent, '200');
    assert.equal(second.options[3].textContent, 'claude-sonnet-5');
    assert.equal(second.options[4].textContent, '850ms');
    assert.equal(second.options[5].textContent, '💭 ⇄');

    // 点击展开详情行：textContent 展示脱敏头 JSON；再次点击收起（remove）。
    await second.dispatch('click');
    // after() 把详情行插到 second.options（mock 无真实兄弟链），而非 table。
    const detail = second.options[6];
    assert.equal(detail.className, 'request-detail');
    assert.match(String(detail.options[0].textContent), /请求头 /);
    assert.match(String(detail.options[0].textContent), /content-type/);
    // 模拟 DOM 兄弟链：row.nextSibling → 详情行，第二次点击走 remove 分支。
    second.nextSibling = detail;
    await second.dispatch('click');
    assert.equal(detail.removed, true);
});

test('API: /api/usage rejects invalid token and non-GET', async (t) => {
    const api = await startApi({
        read: () => ({ forwardSuggestionMode: false, thinkingAsText: true }),
        write: () => assert.fail('write should not run')
    });
    t.after(api.close);

    const unauthorized = await fetch(`${api.origin}/api/usage`);
    assert.equal(unauthorized.status, 401);

    const post = await fetch(`${api.origin}/api/usage`, {
        method: 'POST',
        headers: authHeaders(api, { Origin: api.origin, 'Content-Type': 'application/json' }),
        body: '{}'
    });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
});
