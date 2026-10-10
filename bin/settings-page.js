// 设置页 HTML 渲染：样式常量、内联脚本与组装函数。
// 脚本状态机：初始 disabled → bootstrap+load+lease 全成功后启用 → PATCH 期间禁用
// → 成功采权威快照 / 失败回滚 → 租约断开后保持禁用（setDisabled 由状态派生）。

const PAGE_STYLES = `
:root {
    color-scheme: dark;
    --page-bg: #090a0c;
    --card-bg: #15171b;
    --border: #292d33;
    --text: #e8eaed;
    --muted: #8b919a;
    --accent: #2bbbad;
    --switch-off: #30353d;
    --error: #f07178;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    min-height: 100vh;
    background: var(--page-bg);
    color: var(--text);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 18px 0; }
header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 12px; }
h1 { margin: 0; font-size: 17px; font-weight: 650; }
header p, .description { color: var(--muted); }
header p { margin: 0; }
.section-title { margin: 0 0 6px; color: var(--muted); font-size: 11px; letter-spacing: .08em; }
.card { overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); }
.setting { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 48px; padding: 8px 16px; }
.setting + .setting { border-top: 1px solid var(--border); }
.copy { max-width: 860px; }
h2 { margin: 0; font-size: 13px; font-weight: 620; }
.description { margin: 0; font-size: 12px; }
.controls { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; }
.switch { position: relative; flex: 0 0 auto; width: 38px; height: 22px; }
.switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.track { display: flex; align-items: center; padding: 3px; width: 38px; height: 22px; border-radius: 999px; background: var(--switch-off); cursor: pointer; transition: background .18s ease; }
.track::after { content: ""; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .18s ease; }
.switch input:checked + .track { background: var(--accent); }
.switch input:checked + .track::after { transform: translateX(16px); }
.switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
.switch input:disabled + .track { cursor: wait; opacity: .62; }
select {
    flex: 0 0 auto;
    height: 28px;
    padding: 0 24px 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card-bg);
    color: var(--text);
    font: inherit;
    appearance: none;
    /* 自绘下拉箭头（内联 data URI 无法引用 CSS 变量）：箭头色 #8b919a 须与 --muted 保持同步 */
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%238b919a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 8px center;
}
select:hover:not(:disabled) { border-color: var(--accent); }
select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
select:disabled { cursor: wait; opacity: .62; }
textarea {
    display: block;
    width: 100%;
    min-height: 132px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--page-bg);
    color: var(--text);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical;
}
textarea:hover:not(:disabled) { border-color: var(--accent); }
textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
textarea:disabled { cursor: wait; opacity: .62; }
.prompt-block { display: block; padding: 10px 16px 14px; }
.status { min-height: 20px; margin: 8px 4px 0; color: var(--muted); }
.status.error { color: var(--error); }
@media (max-width: 640px) {
    main { width: min(100% - 24px, 1120px); padding: 12px 0; }
    header { display: block; }
    header p { margin-top: 4px; }
    .setting { min-height: 52px; padding: 8px 14px; gap: 16px; }
}
`;

const PAGE_BODY = `
<main>
    <header>
        <h1>设置</h1>
        <p>配置切换后立即保存，并在下次启动会话生效</p>
    </header>
    <p class="section-title">服务</p>
    <section class="card" aria-label="服务设置">
        <div class="setting">
            <div class="copy">
                <h2>Suggestion Mode 输入建议转发</h2>
                <p class="description">开启后转发输入建议请求并额外消耗 token；关闭时由代理返回空响应。</p>
            </div>
            <label class="switch" for="forwardSuggestionMode">
                <input id="forwardSuggestionMode" type="checkbox" disabled>
                <span class="track" aria-hidden="true"></span>
            </label>
        </div>
        <div class="setting">
            <div class="copy">
                <h2>思考内容文本化展示</h2>
                <p class="description">开启后把思考内容转为普通文本；关闭后恢复 Claude Code 原生折叠 Thinking 块。</p>
            </div>
            <label class="switch" for="thinkingAsText">
                <input id="thinkingAsText" type="checkbox" disabled>
                <span class="track" aria-hidden="true"></span>
            </label>
        </div>
        <div class="setting">
            <div class="copy">
                <h2>Effort 覆写</h2>
                <p class="description">开启后无论 Claude Code 本地 effort 设置是什么，请求均以所选档位转发。</p>
            </div>
            <div class="controls">
                <select id="effortOverrideLevel" aria-label="Effort 档位" disabled>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                    <option value="ultracode">ultracode</option>
                </select>
                <label class="switch" for="effortOverrideEnabled">
                    <input id="effortOverrideEnabled" type="checkbox" disabled>
                    <span class="track" aria-hidden="true"></span>
                </label>
            </div>
        </div>
        <div class="setting">
            <div class="copy">
                <h2>系统提示词覆写</h2>
                <p class="description">开启后所有请求的 system 提示词被替换为下方文本（为空时不生效）。覆写可能使 Claude Code 内置工具与技能说明失效。</p>
            </div>
            <div class="controls">
                <select id="systemPromptTemplate" aria-label="系统提示词模板" disabled>
                    <option value="">选择模板…</option>
                </select>
                <label class="switch" for="systemPromptOverrideEnabled">
                    <input id="systemPromptOverrideEnabled" type="checkbox" disabled>
                    <span class="track" aria-hidden="true"></span>
                </label>
            </div>
        </div>
        <div class="prompt-block">
            <textarea id="systemPromptOverridePrompt" aria-label="自定义系统提示词" disabled spellcheck="false"></textarea>
        </div>
    </section>
    <p id="status" class="status" role="status" aria-live="polite"></p>
</main>
`;

const PAGE_SCRIPT = `
(() => {
    // 页面级 nonce 由 renderSettingsPage 注入下方 bootstrapNonce 的 JSON 字面量。
    const bootstrapNonce = __CC_PROXY_BOOTSTRAP_NONCE__;
    let headers;
    let authoritativeSnapshot = null;
    // 租约活跃状态：租约断开后必须保持禁用，PATCH 完成不得重新启用。
    let leaseActive = false;
    // 是否存在进行中的 PATCH 保存。
    let saving = false;
    const status = document.getElementById('status');
    // 布尔开关字段；effortOverride / systemPromptOverride 为嵌套字段。
    const switchFields = [
        'forwardSuggestionMode',
        'thinkingAsText',
        'effortOverrideEnabled',
        'systemPromptOverrideEnabled'
    ];
    // 所需禁用的全部控件（开关 + 档位/模板下拉 + 提示词输入框）。
    const controls = [
        ...switchFields,
        'effortOverrideLevel',
        'systemPromptTemplate',
        'systemPromptOverridePrompt'
    ];
    // 预置中文模板：选择后仅填入输入框，不直接保存。
    const SYSTEM_PROMPT_TEMPLATES = [
        {
            name: '极简模式',
            text: 'You are a concise assistant. Answer directly with the minimum necessary words. No preamble, no restating the question.'
        },
        {
            name: '中文优先',
            text: '你是一个乐于助人的智能助手。请始终使用简体中文回答，回答应准确、直接、结构清晰；代码与专有技术名词保持原文。'
        },
        {
            name: '默认+追加规则',
            text: "You are Claude Code, Anthropic's official CLI for Claude.\\nAdditional rules:\\n- Keep responses short and actionable.\\n- Show diffs instead of prose explanations."
        }
    ];

    // disabled 由状态派生：租约不活跃或有保存进行中 → 禁用。
    function setDisabled(disabled) {
        const effective = disabled || !leaseActive || saving;
        for (const key of controls) {
            document.getElementById(key).disabled = effective;
        }
    }

    function applySettings(data) {
        for (const key of switchFields) {
            const value = key === 'effortOverrideEnabled'
                ? data.effortOverride?.enabled
                : key === 'systemPromptOverrideEnabled'
                    ? data.systemPromptOverride?.enabled
                    : data[key];
            document.getElementById(key).checked = value;
        }
        document.getElementById('effortOverrideLevel').value
            = data.effortOverride?.level ?? 'high';
        document.getElementById('systemPromptOverridePrompt').value
            = data.systemPromptOverride?.prompt ?? '';
    }

    function acceptSettings(data) {
        authoritativeSnapshot = {
            forwardSuggestionMode: data.forwardSuggestionMode,
            thinkingAsText: data.thinkingAsText,
            effortOverride: {
                enabled: data.effortOverride?.enabled,
                level: data.effortOverride?.level
            },
            systemPromptOverride: {
                enabled: data.systemPromptOverride?.enabled,
                prompt: data.systemPromptOverride?.prompt
            }
        };
        applySettings(authoritativeSnapshot);
    }

    function show(message, isError = false) {
        status.textContent = message;
        status.classList.toggle('error', isError);
    }

    async function bootstrap() {
        const response = await fetch('/api/bootstrap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: bootstrapNonce })
        });
        // nonce 为一次性凭据：浏览器恢复标签页 / bfcache / 重复打开旧地址时
        // 会复用过期或已消费的 nonce，服务端返回非 2xx。此时整页重载一次
        // 换取新 nonce；sessionStorage 防止服务异常时无限刷新循环。
        if (!response.ok) {
            if (!sessionStorage.getItem('bootstrap-retried')) {
                sessionStorage.setItem('bootstrap-retried', '1');
                location.reload();
                return new Promise(() => {});
            }
            throw new Error('页面认证失败，请重新打开设置页');
        }
        sessionStorage.removeItem('bootstrap-retried');
        const { data } = await response.json();
        headers = { 'X-CC-Proxy-Token': data.token };
    }

    async function load() {
        const response = await fetch('/api/settings', { headers });
        if (!response.ok) throw new Error('读取设置失败');
        const { data } = await response.json();
        acceptSettings(data);
    }

    for (const key of switchFields) {
        const input = document.getElementById(key);
        input.addEventListener('change', async () => {
            const requestedValue = input.checked;
            // 嵌套字段对应的 API key；顶层布尔 key 保持原名。
            const apiKey = key === 'effortOverrideEnabled'
                ? 'effortOverride.enabled'
                : key === 'systemPromptOverrideEnabled'
                    ? 'systemPromptOverride.enabled'
                    : key;
            saving = true;
            setDisabled(true);
            try {
                // 系统提示词开关首次开启且输入框为空：先拉取捕获的 CC 默认
                // 提示词预填并提交 prompt，再提交 enabled（保证首次开启即
                // 带着预填内容生效；无捕获数据时保持为空继续保存）。
                if (key === 'systemPromptOverrideEnabled' && requestedValue
                    && !document.getElementById('systemPromptOverridePrompt').value) {
                    try {
                        const captured = await fetch('/api/captured-system-prompt', { headers });
                        if (captured.ok) {
                            const { data } = await captured.json();
                            if (data?.prompt) {
                                document.getElementById('systemPromptOverridePrompt').value = data.prompt;
                                await patchSetting('systemPromptOverride.prompt', data.prompt);
                            }
                        }
                    } catch {
                        // 预填失败不阻断开关保存。
                    }
                }
                await patchSetting(apiKey, requestedValue);
                show('设置已保存，将在下次启动会话生效');
            } catch (error) {
                if (authoritativeSnapshot) {
                    applySettings(authoritativeSnapshot);
                }
                show(error.message, true);
            } finally {
                saving = false;
                // 仅在租约仍活跃时恢复启用；租约已断开则保持禁用。
                setDisabled(!leaseActive);
            }
        });
    }

    async function patchSetting(key, value) {
        const response = await fetch('/api/settings', {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value })
        });
        if (!response.ok) throw new Error('保存失败');
        const { data } = await response.json();
        acceptSettings(data);
    }

    // Effort 档位下拉：提交 effortOverride.level，保存期间禁用全部控件。
    document.getElementById('effortOverrideLevel').addEventListener('change', async (event) => {
        const select = event.currentTarget;
        const requestedValue = select.value;
        saving = true;
        setDisabled(true);
        try {
            await patchSetting('effortOverride.level', requestedValue);
            show('设置已保存，将在下次启动会话生效');
        } catch (error) {
            if (authoritativeSnapshot) {
                applySettings(authoritativeSnapshot);
            }
            show(error.message, true);
        } finally {
            saving = false;
            // 仅在租约仍活跃时恢复启用；租约已断开则保持禁用。
            setDisabled(!leaseActive);
        }
    });

    // 系统提示词模板下拉：仅填入输入框不保存（用户还有修改机会）。
    const templateSelect = document.getElementById('systemPromptTemplate');
    for (const { name, text } of SYSTEM_PROMPT_TEMPLATES) {
        const option = document.createElement('option');
        option.value = text;
        option.textContent = name;
        templateSelect.appendChild(option);
    }
    templateSelect.addEventListener('change', (event) => {
        const select = event.currentTarget;
        if (select.value) {
            document.getElementById('systemPromptOverridePrompt').value = select.value;
        }
        // 重置为占位项，允许重复选择同一模板。
        select.value = '';
    });

    // 系统提示词输入框：blur 时与权威快照不同则提交 prompt。
    document.getElementById('systemPromptOverridePrompt').addEventListener('blur', async (event) => {
        const textarea = event.currentTarget;
        const snapshotPrompt = authoritativeSnapshot?.systemPromptOverride?.prompt;
        if (textarea.value === snapshotPrompt) return;
        saving = true;
        setDisabled(true);
        try {
            await patchSetting('systemPromptOverride.prompt', textarea.value);
            show('设置已保存，将在下次启动会话生效');
        } catch (error) {
            if (authoritativeSnapshot) {
                applySettings(authoritativeSnapshot);
            }
            show(error.message, true);
        } finally {
            saving = false;
            // 仅在租约仍活跃时恢复启用；租约已断开则保持禁用。
            setDisabled(!leaseActive);
        }
    });

    async function openLease() {
        const response = await fetch('/api/session', { headers });
        if (!response.ok || !response.body) throw new Error('设置页面连接失败');
        return response.body;
    }

    async function initialize() {
        await bootstrap();
        const [, body] = await Promise.all([load(), openLease()]);
        leaseActive = true;
        setDisabled(false);
        await body.pipeTo(new WritableStream());
        // 服务端正常关闭租约（超时/单租户抢占）也视为断开并保持禁用。
        throw new Error('设置页面连接已断开');
    }

    initialize().catch((error) => {
        leaseActive = false;
        setDisabled(true);
        show(error.message, true);
    });
})();
`;

export function renderSettingsPage(bootstrapNonce = '') {
    // 函数替换：避免替换串中的 $& 等特殊模式破坏注入结果；
    // stringify 后转义 <，防止 </script> 从内联脚本标签逃逸。
    const script = PAGE_SCRIPT.replace(
        '__CC_PROXY_BOOTSTRAP_NONCE__',
        () => JSON.stringify(bootstrapNonce).replace(/</g, '\\u003c')
    );
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cc-proxy 设置</title>
<style>${PAGE_STYLES}</style>
</head>
<body>${PAGE_BODY}
<script>${script}</script>
</body>
</html>`;
}
