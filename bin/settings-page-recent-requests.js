// 最近请求表脚本片段：由 settings-page.js 拼接进唯一内联 <script>，与主脚本
// 共享同一 IIFE 闭包（headers / show / document / fetch 等）。
// 约束：本文件为模板字符串字面量，内部禁止使用反引号模板串（用 '+' 拼接）。
export const RECENT_REQUESTS_SCRIPT = `
    // 最近请求表：读 /api/recent-requests 落盘文件，失败静默降级，绝不阻断设置功能。
    function formatRequestTime(iso) {
        // 快照 time 为 ISO 字符串：只显示 月-日 时:分:秒，解析失败原样返回。
        const d = typeof iso === 'string' ? new Date(iso) : null;
        if (!d || Number.isNaN(d.getTime())) return String(iso ?? '');
        const pad = (n) => String(n).padStart(2, '0');
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function formatRequestStatus(statusCode) {
        if (!Number.isInteger(statusCode)) return '失败';
        return String(statusCode);
    }

    // 单行表格：时间 · 状态 · 上游 · 模型 · TTFT · 💭/切换标记；全部
    // textContent 渲染防注入（与上游状态表同口径）。
    function renderRecentRequestRow(table, entry) {
        const row = document.createElement('tr');
        const cells = [
            formatRequestTime(entry?.time),
            formatRequestStatus(entry?.statusCode),
            String(entry?.upstream ?? ''),
            String(entry?.model ?? ''),
            formatMs(entry?.ttftMs)
        ];
        const flags = [];
        if (entry?.thinkingRewritten) flags.push('💭');
        if (entry?.failedOver) flags.push('⇄');
        cells.push(flags.join(' '));
        for (const cell of cells) {
            const td = document.createElement('td');
            td.textContent = cell;
            row.appendChild(td);
        }
        // 点击展开/收起脱敏头摘要详情行。
        row.addEventListener('click', () => {
            const next = row.nextSibling;
            if (next && next.classList && next.classList.contains('request-detail')) {
                next.remove();
                return;
            }
            const detail = document.createElement('tr');
            detail.className = 'request-detail';
            const td = document.createElement('td');
            td.colSpan = cells.length;
            td.textContent = '请求头 ' + JSON.stringify(entry?.requestHeaders ?? {})
                + ' · 响应头 ' + JSON.stringify(entry?.responseHeaders ?? {});
            detail.appendChild(td);
            row.after(detail);
        });
        table.appendChild(row);
    }

    function renderRecentRequests(data) {
        const board = document.getElementById('recentRequestsBoard');
        board.textContent = '';
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        if (entries.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'usage-empty';
            empty.textContent = '暂无最近请求数据';
            board.appendChild(empty);
            return;
        }
        const table = document.createElement('table');
        table.className = 'usage-table';
        const head = document.createElement('tr');
        for (const label of ['时间', '状态', '上游', '模型', 'TTFT', '标记']) {
            const th = document.createElement('th');
            th.textContent = label;
            head.appendChild(th);
        }
        table.appendChild(head);
        // 最新在前（环形缓冲 push 追加，倒序展示）。
        for (const entry of entries.slice(-50).reverse()) {
            if (entry && typeof entry === 'object') renderRecentRequestRow(table, entry);
        }
        board.appendChild(table);
    }

    async function loadRecentRequests() {
        try {
            const response = await fetch('/api/recent-requests', { headers });
            if (!response.ok) throw new Error('recent-requests http ' + response.status);
            const { data } = await response.json();
            renderRecentRequests(data);
        } catch {
            const board = document.getElementById('recentRequestsBoard');
            board.textContent = '';
            const empty = document.createElement('p');
            empty.className = 'usage-empty';
            empty.textContent = '最近请求不可用';
            board.appendChild(empty);
        }
    }
`;
