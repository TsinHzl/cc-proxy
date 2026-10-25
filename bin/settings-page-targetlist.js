// 定向目标上游列表工厂：usageScale 与 effortOverride 共用同一套行增删 /
// 本地 URL 校验 / blur 全量提交逻辑，按 key 前缀生成元素 id（<key>TargetList、
// <key>TargetAdd）与 controller。settings-page.js 只做接线：拼接 HTML/样式/
// 脚本，并在 setDisabled / applySettings / acceptSettings 三处调用本模块
// 导出的控制器函数（syncTargetListControls / renderTargetLists /
// targetListSnapshot）。
// 约束：脚本部分为模板字符串字面量，内部禁止使用反引号模板串（用字符串拼接）。

// 两个列表的描述：key 决定元素 id 前缀，group 决定提交的配置命名空间。
export const SCALE_TARGET_LIST = {
    key: 'scale',
    group: 'usageScale',
    title: '目标上游 Base URL（留空 = 对所有上游缩放）',
    hint: '仅当实际转发命中的上游完整 base URL 匹配列表项时缩放；未配置时对所有上游生效。修改后下次启动会话生效。'
};

export const EFFORT_TARGET_LIST = {
    key: 'effort',
    group: 'effortOverride',
    title: '目标上游 Base URL（留空 = 对所有上游覆写）',
    hint: '仅当实际转发命中的上游完整 base URL 匹配列表项时覆写 effort 档位；未配置时对所有上游生效。修改后下次启动会话生效。'
};

export const TARGET_LISTS = [SCALE_TARGET_LIST, EFFORT_TARGET_LIST];

const TARGET_LIST_STYLES = `
.targets { display: block; padding: 0 16px 14px; }
.targets-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.targets-title { font-size: 12px; color: var(--muted); }
.targets-add { padding: 3px 12px; font-size: 12px; border: 1px solid var(--border); border-radius: 12px; background: transparent; color: var(--muted); cursor: pointer; }
.targets-add:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.targets-add:disabled { cursor: wait; opacity: .62; }
.target-list { display: flex; flex-direction: column; gap: 6px; }
.target-row { display: flex; gap: 6px; }
.target-url { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg); color: var(--text); font: inherit; }
.target-url:hover:not(:disabled) { border-color: var(--accent); }
.target-url:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.target-url:disabled { cursor: wait; opacity: .62; }
.target-url:invalid { border-color: var(--error); }
.target-remove { flex: 0 0 auto; padding: 0 10px; height: 28px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; font: inherit; }
.target-remove:hover:not(:disabled) { border-color: var(--error); color: var(--error); }
.target-remove:disabled { cursor: wait; opacity: .62; }
.targets-hint { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
`;

export function buildTargetListStyles() {
    return TARGET_LIST_STYLES;
}

// 单列表 HTML 片段：由 settings-page.js 插入对应设置卡片之后。
export function buildTargetListHtml(list) {
    return `
        <div class="targets">
            <div class="targets-head">
                <span class="targets-title">${list.title}</span>
                <button id="${list.key}TargetAdd" type="button" class="targets-add" disabled>+ 添加</button>
            </div>
            <div id="${list.key}TargetList" class="target-list"></div>
            <p class="targets-hint">${list.hint}</p>
        </div>
`;
}

// 列表脚本片段：与主脚本共享同一 IIFE 闭包（document / show / patchSetting /
// setDisabled / saving / leaseActive / authoritativeSnapshot / applySettings）。
export function buildTargetListScript(lists) {
    const spec = JSON.stringify(lists.map((item) => ({ key: item.key, group: item.group })));
    return `
    // 定向目标上游列表：动态行增删 + blur 时全量提交 <group>.baseUrls。
    // rows 以内部数组跟踪（不依赖 DOM 查询），行元素为 [input, remove]。
    var TARGET_LISTS = ` + spec + `;
    var targetListEntries = TARGET_LISTS.map((spec) => {
        var rows = [];
        var listEl = document.getElementById(spec.key + 'TargetList');
        var addEl = document.getElementById(spec.key + 'TargetAdd');
        var apiKey = spec.group + '.baseUrls';

        function syncControls(disabled) {
            if (addEl) addEl.disabled = disabled;
            for (const entry of rows) {
                entry.input.disabled = disabled;
                entry.remove.disabled = disabled;
            }
        }

        function currentValues() {
            return rows
                .map((entry) => entry.input.value.trim())
                .filter(Boolean);
        }

        function addRow(value) {
            if (!listEl) return null;
            const row = document.createElement('div');
            row.className = 'target-row';
            const input = document.createElement('input');
            input.type = 'url';
            input.className = 'target-url';
            // 占位符不写完整协议字面量：设置页禁止任何外部 URL 样式文本（测试约束）。
            input.placeholder = '输入 Base URL（含协议）';
            input.value = value || '';
            input.setAttribute('aria-label', '目标上游 Base URL');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'target-remove';
            remove.textContent = '删除';
            remove.setAttribute('aria-label', '删除该目标上游');
            row.appendChild(input);
            row.appendChild(remove);
            listEl.appendChild(row);
            const entry = { row, input, remove };
            rows.push(entry);
            input.addEventListener('blur', () => submit());
            // pointerdown 仅阻止焦点转移（避免输入框 blur 提交把按钮置 disabled
            // 后吞掉本次 click）；业务动作保留在 click 上，保证键盘 Enter/Space
            // 与触屏均可正常触发。
            remove.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
            });
            remove.addEventListener('click', () => {
                rows = rows.filter((item) => item !== entry);
                row.remove();
                submit();
            });
            return entry;
        }

        // 以权威快照重建列表（加载 / 保存成功 / 非法回滚共用）。
        function render(baseUrls) {
            rows = [];
            if (listEl) listEl.textContent = '';
            for (const value of Array.isArray(baseUrls) ? baseUrls : []) {
                addRow(value);
            }
            syncControls(!leaseActive || saving);
        }

        // 本地校验：逐项须为可解析的 http(s) URL；非法时不提交并回滚展示。
        function isUrl(value) {
            try {
                const parsed = new URL(value);
                return parsed.protocol === 'http:' || parsed.protocol === 'https:';
            } catch {
                return false;
            }
        }

        async function submit() {
            // 防重入：setDisabled(true) 会把已聚焦输入框置 disabled，浏览器随即
            // 触发 blur 再次进入本函数；saving 期间直接返回，避免并发 PATCH 与
            // 响应交错导致的控件提前解锁 / 快照回滚。租约断开后控件保持禁用，
            // 此时 blur 不应再发起请求（否则失败提示会覆盖「连接已断开」）。
            if (saving || !leaseActive) return;
            const values = currentValues();
            if (!values.every(isUrl)) {
                show('目标上游须为 http(s) URL', true);
                render(authoritativeSnapshot?.[spec.group]?.baseUrls ?? []);
                return;
            }
            const snapshot = authoritativeSnapshot?.[spec.group]?.baseUrls ?? [];
            if (values.length === snapshot.length
                && values.every((value, index) => value === snapshot[index])) {
                return;
            }
            saving = true;
            setDisabled(true);
            try {
                await patchSetting(apiKey, values);
                show('设置已保存，将在下次启动会话生效');
            } catch (error) {
                if (authoritativeSnapshot) applySettings(authoritativeSnapshot);
                show(error.message, true);
            } finally {
                saving = false;
                setDisabled(!leaseActive);
            }
        }

        if (addEl) {
            // 同上：pointerdown 只阻止焦点转移，实际添加在 click 中执行。
            addEl.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
            });
            addEl.addEventListener('click', () => {
                if (!leaseActive || saving) return;
                addRow('');
                syncControls(false);
            });
        }

        return { group: spec.group, syncControls, render };
    });

    // 控件禁用态同步（setDisabled 内调用，覆盖租约断开与保存中两条路径）。
    function syncTargetListControls(disabled) {
        for (const item of targetListEntries) item.syncControls(disabled);
    }

    // 按服务端返回数据以权威快照重建全部列表（加载 / 保存成功 / 非法回滚共用）。
    function renderTargetLists(data) {
        for (const item of targetListEntries) {
            item.render(data?.[item.group]?.baseUrls ?? []);
        }
    }

    // 权威快照的 baseUrls 部分：group → 数组副本（防后续原地改写入快照）。
    function targetListSnapshot(data) {
        const snapshot = {};
        for (const item of targetListEntries) {
            const baseUrls = data?.[item.group]?.baseUrls;
            snapshot[item.group] = Array.isArray(baseUrls) ? [...baseUrls] : [];
        }
        return snapshot;
    }
`;
}