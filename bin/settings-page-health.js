// 上游状态看板脚本片段：由 settings-page.js 拼接进唯一内联 <script>，与主脚本
// 共享同一 IIFE 闭包（headers / show / document / fetch 等）。
// 约束：本文件为模板字符串字面量，内部禁止使用反引号模板串（用 '+' 拼接）。
export const HEALTH_BOARD_SCRIPT = `
    // 上游状态看板：读 /api/upstream-health 落盘快照，失败静默降级，绝不阻断设置功能。
    function formatPercent(value) {
        if (!Number.isFinite(value)) return 'n/a';
        return (value * 100).toFixed(1) + '%';
    }

    function formatMs(value) {
        if (!Number.isFinite(value)) return 'n/a';
        return value >= 1000 ? (value / 1000).toFixed(2) + 's' : Math.round(value) + 'ms';
    }

    function formatFailoverTime(iso) {
        // 快照 time 为 ISO 字符串：只显示 月-日 时:分，解析失败原样返回。
        const d = typeof iso === 'string' ? new Date(iso) : null;
        if (!d || Number.isNaN(d.getTime())) return String(iso ?? '');
        const pad = (n) => String(n).padStart(2, '0');
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // 单上游行：成功率 = (requests - failures) / requests，无请求时不计。
    function renderHealthUpstream(board, upstream) {
        const row = document.createElement('p');
        row.className = 'usage-summary';
        const successRate = upstream.requests > 0
            ? (upstream.requests - (upstream.failures || 0)) / upstream.requests
            : null;
        row.appendChild(document.createTextNode(
            upstream.id + ' · 成功率 ' + formatPercent(successRate)
                + ' · TTFT p50 ' + formatMs(upstream.ttftP50)
                + ' / p95 ' + formatMs(upstream.ttftP95)
                + ' · 请求 ' + String(upstream.requests ?? 0)
                + ' · 失败 ' + String(upstream.failures || 0)
        ));
        board.appendChild(row);
    }

    // 最近切换列表：时间 + from → to + 原因，全部 textContent 渲染防注入。
    function renderHealthFailovers(board, failovers) {
        if (!Array.isArray(failovers) || failovers.length === 0) return;
        const title = document.createElement('p');
        title.className = 'usage-summary';
        title.textContent = '最近切换：';
        board.appendChild(title);
        const table = document.createElement('table');
        table.className = 'usage-table';
        for (const item of failovers.slice(0, 20)) {
            const row = document.createElement('tr');
            for (const cell of [
                formatFailoverTime(item?.time),
                String(item?.from ?? ''),
                '→ ' + String(item?.to ?? ''),
                String(item?.reason ?? '')
            ]) {
                const td = document.createElement('td');
                td.textContent = cell;
                row.appendChild(td);
            }
            table.appendChild(row);
        }
        board.appendChild(table);
    }

    function renderUpstreamHealth(data) {
        const board = document.getElementById('healthBoard');
        board.textContent = '';
        const upstreams = Array.isArray(data?.upstreams) ? data.upstreams : [];
        if (upstreams.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'usage-empty';
            empty.textContent = '暂无上游请求数据';
            board.appendChild(empty);
            return;
        }
        for (const upstream of upstreams) {
            if (upstream && typeof upstream === 'object') renderHealthUpstream(board, upstream);
        }
        renderHealthFailovers(board, data.failovers);
    }

    async function loadUpstreamHealth() {
        try {
            const response = await fetch('/api/upstream-health', { headers });
            if (!response.ok) throw new Error('health http ' + response.status);
            const { data } = await response.json();
            renderUpstreamHealth(data);
        } catch {
            const board = document.getElementById('healthBoard');
            board.textContent = '';
            const empty = document.createElement('p');
            empty.className = 'usage-empty';
            empty.textContent = '上游状态不可用';
            board.appendChild(empty);
        }
    }
`;
