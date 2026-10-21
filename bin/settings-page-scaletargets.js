// 定向缩放目标上游列表片段：样式、HTML 与脚本三部分由 settings-page.js
// 拼接进设置页。脚本与主脚本共享同一 IIFE 闭包（document / show /
// patchSetting / setDisabled / saving / leaseActive / authoritativeSnapshot /
// applySettings 等）。
// 约束：本文件为模板字符串字面量，内部禁止使用反引号模板串（用字符串拼接）。

export const SCALE_TARGETS_STYLES = `
.scale-targets { display: block; padding: 0 16px 14px; }
.scale-targets-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.scale-targets-title { font-size: 12px; color: var(--muted); }
.scale-target-add { padding: 3px 12px; font-size: 12px; border: 1px solid var(--border); border-radius: 12px; background: transparent; color: var(--muted); cursor: pointer; }
.scale-target-add:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.scale-target-add:disabled { cursor: wait; opacity: .62; }
.scale-target-list { display: flex; flex-direction: column; gap: 6px; }
.scale-target-row { display: flex; gap: 6px; }
.scale-target-url { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--text); font: inherit; }
.scale-target-url:hover:not(:disabled) { border-color: var(--accent); }
.scale-target-url:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.scale-target-url:disabled { cursor: wait; opacity: .62; }
.scale-target-url:invalid { border-color: var(--error); }
.scale-target-remove { flex: 0 0 auto; padding: 0 10px; height: 28px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; font: inherit; }
.scale-target-remove:hover:not(:disabled) { border-color: var(--error); color: var(--error); }
.scale-target-remove:disabled { cursor: wait; opacity: .62; }
.scale-targets-hint { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
`;

export const SCALE_TARGETS_HTML = `
        <div class="scale-targets">
            <div class="scale-targets-head">
                <span class="scale-targets-title">目标上游 Base URL（留空 = 对所有上游缩放）</span>
                <button id="scaleTargetAdd" type="button" class="scale-target-add" disabled>+ 添加</button>
            </div>
            <div id="scaleTargetList" class="scale-target-list"></div>
            <p class="scale-targets-hint">仅当实际转发命中的上游完整 base URL 匹配列表项时缩放；未配置时对所有上游生效。修改后下次启动会话生效。</p>
        </div>
`;

export const SCALE_TARGETS_SCRIPT = `
    // 定向缩放目标上游列表：动态行增删 + blur 时全量提交 usageScale.baseUrls。
    // rows 以内部数组跟踪（不依赖 DOM 查询），行元素为 [input, remove]。
    var scaleTargetRows = [];
    var scaleTargetListEl = document.getElementById('scaleTargetList');
    var scaleTargetAddEl = document.getElementById('scaleTargetAdd');

    function syncScaleTargetControls(disabled) {
        if (scaleTargetAddEl) scaleTargetAddEl.disabled = disabled;
        for (const entry of scaleTargetRows) {
            entry.input.disabled = disabled;
            entry.remove.disabled = disabled;
        }
    }

    function currentScaleTargetValues() {
        return scaleTargetRows
            .map((entry) => entry.input.value.trim())
            .filter(Boolean);
    }

    function addScaleTargetRow(value) {
        if (!scaleTargetListEl) return;
        const row = document.createElement('div');
        row.className = 'scale-target-row';
        const input = document.createElement('input');
        input.type = 'url';
        input.className = 'scale-target-url';
        // 占位符不写完整协议字面量：设置页禁止任何外部 URL 样式文本（测试约束）。
        input.placeholder = '输入 Base URL（含协议）';
        input.value = value || '';
        input.setAttribute('aria-label', '目标上游 Base URL');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'scale-target-remove';
        remove.textContent = '删除';
        remove.setAttribute('aria-label', '删除该目标上游');
        row.appendChild(input);
        row.appendChild(remove);
        scaleTargetListEl.appendChild(row);
        const entry = { row, input, remove };
        scaleTargetRows.push(entry);
        input.addEventListener('blur', () => submitScaleTargets());
        // pointerdown 仅阻止焦点转移（避免输入框 blur 提交把按钮置 disabled
        // 后吞掉本次 click）；业务动作保留在 click 上，保证键盘 Enter/Space
        // 与触屏均可正常触发。
        remove.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
        });
        remove.addEventListener('click', () => {
            scaleTargetRows = scaleTargetRows.filter((item) => item !== entry);
            row.remove();
            submitScaleTargets();
        });
        return entry;
    }

    // 以权威快照重建列表（加载 / 保存成功 / 非法回滚共用）。
    function renderScaleTargets(baseUrls) {
        scaleTargetRows = [];
        if (scaleTargetListEl) scaleTargetListEl.textContent = '';
        for (const value of Array.isArray(baseUrls) ? baseUrls : []) {
            addScaleTargetRow(value);
        }
        syncScaleTargetControls(!leaseActive || saving);
    }

    // 本地校验：逐项须为可解析的 http(s) URL；非法时不提交并回滚展示。
    function isScaleTargetUrl(value) {
        try {
            const parsed = new URL(value);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
            return false;
        }
    }

    async function submitScaleTargets() {
        // 防重入：setDisabled(true) 会把已聚焦输入框置 disabled，浏览器随即
        // 触发 blur 再次进入本函数；saving 期间直接返回，避免并发 PATCH 与
        // 响应交错导致的控件提前解锁 / 快照回滚。租约断开后控件保持禁用，
        // 此时 blur 不应再发起请求（否则失败提示会覆盖「连接已断开」）。
        if (saving || !leaseActive) return;
        const values = currentScaleTargetValues();
        if (!values.every(isScaleTargetUrl)) {
            show('目标上游须为 http(s) URL', true);
            renderScaleTargets(authoritativeSnapshot?.usageScale?.baseUrls ?? []);
            return;
        }
        const snapshot = authoritativeSnapshot?.usageScale?.baseUrls ?? [];
        if (values.length === snapshot.length
            && values.every((value, index) => value === snapshot[index])) {
            return;
        }
        saving = true;
        setDisabled(true);
        try {
            await patchSetting('usageScale.baseUrls', values);
            show('设置已保存，将在下次启动会话生效');
        } catch (error) {
            if (authoritativeSnapshot) applySettings(authoritativeSnapshot);
            show(error.message, true);
        } finally {
            saving = false;
            setDisabled(!leaseActive);
        }
    }

    if (scaleTargetAddEl) {
        // 同上：pointerdown 只阻止焦点转移，实际添加在 click 中执行。
        scaleTargetAddEl.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
        });
        scaleTargetAddEl.addEventListener('click', () => {
            if (!leaseActive || saving) return;
            addScaleTargetRow('');
            syncScaleTargetControls(false);
        });
    }
`;
