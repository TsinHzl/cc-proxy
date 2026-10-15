// 用量看板脚本片段：由 settings-page.js 拼接进唯一内联 <script>，与主脚本
// 共享同一 IIFE 闭包（headers / show / document / fetch / sessionStorage 等）。
// 约束：本文件为模板字符串字面量，内部禁止使用反引号模板串（用 \x27+\x27 拼接）。
export const USAGE_BOARD_SCRIPT = `
    // 用量看板：bootstrap 取到 token 后并行拉取，失败静默降级，绝不阻断设置功能。
    function formatTokens(value) {
        if (!Number.isInteger(value) || value <= 0) return '0';
        if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
        if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
        return String(value);
    }

    function formatCost(cost) {
        // 未配置/未收录模型时 cost 为 null：显示占位而非报错。
        if (cost === null || cost === undefined) return '';
        return '$' + cost.toFixed(2);
    }

    function formatHitRate(hitRate) {
        if (hitRate === null || hitRate === undefined) return 'n/a';
        return (hitRate * 100).toFixed(1) + '%';
    }

    function formatDayLabel(date) {
        const parts = typeof date === 'string' ? date.split('-') : [];
        return parts.length === 3 ? parts[1] + '-' + parts[2] : String(date ?? '');
    }

    // 用量看板三种时间维度：今日 / 七天 / 一个月（30 天），Tab 点击切换。
    const RANGES = [
        { key: 'today', label: '今日', days: 1 },
        { key: 'week', label: '七天', days: 7 },
        { key: 'month', label: '一个月', days: 30 }
    ];
    let currentRange = 'today';
    // API 返回的近 30 天明细缓存：Tab 切换只在前端切片重渲染，不重新请求。
    let usageDays = [];
    // 近一次 /api/usage 的告警字段：Tab 切换重渲染时透传，避免告警信息丢失。
    let usageAlert = null;

    // 区间聚合的 token 求和字段（日级与 byModel 级共用）。
    const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];

    // 区间聚合：切片逐字段求和生成聚合 day，byModel 跨天合并（逐字段相加），
    // hitRate 按合计 token 重算，费用任一参与日不可估则整区间 null。
    function aggregateDays(days, label) {
        const agg = {
            date: label,
            requests: 0, inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheCreationTokens: 0,
            totalTokens: 0, hitRate: null, cost: null, byModel: {}
        };
        let costKnown = days.length > 0;
        let costSum = 0;
        for (const day of days) {
            agg.requests += day.requests || 0;
            for (const field of TOKEN_FIELDS) {
                agg[field] += day[field] || 0;
            }
            if (day.cost === null || day.cost === undefined) costKnown = false;
            else costSum += day.cost;
            for (const [model, entry] of Object.entries(day.byModel || {})) {
                const merged = agg.byModel[model] || (agg.byModel[model] = {
                    requests: 0, inputTokens: 0, outputTokens: 0,
                    cacheReadTokens: 0, cacheCreationTokens: 0
                });
                merged.requests += entry.requests || 0;
                for (const field of TOKEN_FIELDS) {
                    merged[field] += entry[field] || 0;
                }
            }
        }
        agg.totalTokens = agg.inputTokens + agg.outputTokens
            + agg.cacheReadTokens + agg.cacheCreationTokens;
        const hitBase = agg.cacheReadTokens + agg.inputTokens + agg.cacheCreationTokens;
        agg.hitRate = hitBase > 0 ? agg.cacheReadTokens / hitBase : null;
        agg.cost = costKnown ? costSum : null;
        return agg;
    }

    function renderUsageTabs(board) {
        const tabs = document.createElement('div');
        tabs.className = 'usage-tabs';
        for (const range of RANGES) {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'usage-tab' + (range.key === currentRange ? ' active' : '');
            tab.textContent = range.label;
            tab.addEventListener('click', () => {
                if (currentRange === range.key) return;
                currentRange = range.key;
                renderUsageBoard({ days: usageDays, alert: usageAlert });
            });
            tabs.appendChild(tab);
        }
        board.appendChild(tabs);
    }

    // 告警级别归一：仅采信白名单 level；未知值/旧版 alert 回落 exceeded 判断。
    function alertLevel(alert) {
        if (!alert) return 'none';
        if (alert.level === 'warn' || alert.level === 'limit') return alert.level;
        return alert.exceeded ? 'limit' : 'none';
    }

    // 柱状图：totalTokens 归一化高度；今日柱按告警级别着色（limit 红 / warn 黄）。
    function renderUsageBars(board, rangeDays, today, alert) {
        const maxTokens = Math.max(...rangeDays.map((day) => day.totalTokens || 0), 0);
        const bars = document.createElement('div');
        bars.className = 'usage-bars';
        const level = alertLevel(alert);
        for (const day of rangeDays) {
            const col = document.createElement('div');
            col.className = 'usage-bar';
            const fill = document.createElement('div');
            const tone = day === today && (level === 'warn' || level === 'limit')
                ? (level === 'warn' ? ' warn' : ' alert') : '';
            fill.className = 'usage-bar-fill' + tone;
            const ratio = maxTokens > 0 ? (day.totalTokens || 0) / maxTokens : 0;
            fill.style.height = Math.round(ratio * 100) + '%';
            const label = document.createElement('span');
            label.className = 'usage-bar-label';
            label.textContent = formatDayLabel(day.date);
            col.appendChild(fill);
            col.appendChild(label);
            bars.appendChild(col);
        }
        board.appendChild(bars);
    }

    // 汇总行：区间总量 / 命中率 / 费用（null 显示空）/ 两级告警点与已用百分比。
    function renderUsageSummary(board, active, rangeLabel, alert) {
        const summary = document.createElement('p');
        summary.className = 'usage-summary';
        const level = alertLevel(alert);
        if (level === 'warn' || level === 'limit') {
            const percent = Number.isFinite(alert.ratio)
                ? Math.round(alert.ratio * 100) + '%' : '';
            const isWarn = level === 'warn';
            const alertText = isWarn ? '今日用量预警' : '今日用量已超限';
            const dot = document.createElement('span');
            dot.className = 'alert-dot' + (isWarn ? ' warn' : '');
            dot.setAttribute('aria-label', alertText);
            dot.textContent = ' ';
            summary.appendChild(dot);
            summary.appendChild(document.createTextNode(
                alertText + (percent ? ' · 已用 ' + percent : '') + ' · '
            ));
        }
        const activeCost = formatCost(active.cost);
        summary.appendChild(document.createTextNode(
            rangeLabel + ' ' + formatTokens(active.totalTokens) + ' tokens · 命中率 '
                + formatHitRate(active.hitRate)
                + (activeCost ? ' · 费用 ' + activeCost : '')
        ));
        board.appendChild(summary);
    }

    // 按模型表：今日/区间聚合各模型用量；模型名经 textContent 渲染防注入。
    function renderUsageModels(board, active) {
        const models = Object.keys(active.byModel || {});
        if (models.length === 0) return;
        const table = document.createElement('table');
        table.className = 'usage-table';
        const head = document.createElement('tr');
        for (const cell of ['模型', '请求', '输入', '输出', '缓存读', '缓存写']) {
            const th = document.createElement('th');
            th.textContent = cell;
            head.appendChild(th);
        }
        table.appendChild(head);
        for (const model of models) {
            const entry = active.byModel[model] || {};
            const row = document.createElement('tr');
            for (const cell of [
                model,
                String(entry.requests ?? 0),
                formatTokens(entry.inputTokens ?? 0),
                formatTokens(entry.outputTokens ?? 0),
                formatTokens(entry.cacheReadTokens ?? 0),
                formatTokens(entry.cacheCreationTokens ?? 0)
            ]) {
                const td = document.createElement('td');
                td.textContent = cell;
                row.appendChild(td);
            }
            table.appendChild(row);
        }
        board.appendChild(table);
    }

    // 导出按钮行：CSV / JSON 两个入口，点击后带 token 拉取导出接口触发浏览器下载。
    function renderUsageExport(board) {
        const row = document.createElement('div');
        row.className = 'usage-export';
        for (const format of ['csv', 'json']) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'usage-export-btn';
            button.textContent = '导出 ' + format.toUpperCase();
            button.addEventListener('click', () => downloadUsageExport(format));
            row.appendChild(button);
        }
        board.appendChild(row);
    }

    // 下载导出文件：blob URL + download 属性触发保存；revoke 推迟一个宏任务，
    // 避免 Safari 等浏览器在点击分派未完成时提前释放导致下载中断。
    async function downloadUsageExport(format) {
        try {
            const response = await fetch('/api/usage/export?format=' + format, { headers });
            if (!response.ok) throw new Error('export http ' + response.status);
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = 'cc-proxy-usage.' + format;
            try {
                link.click();
            } finally {
                setTimeout(() => URL.revokeObjectURL(url), 0);
            }
        } catch {
            show('用量导出失败', true);
        }
    }

    function renderUsageBoard(data) {
        const board = document.getElementById('usageBoard');
        board.textContent = '';
        const days = Array.isArray(data?.days) ? data.days : [];
        const alert = data?.alert || null;
        usageDays = days;
        usageAlert = alert;
        renderUsageTabs(board);
        renderUsageExport(board);
        if (days.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'usage-empty';
            empty.textContent = '暂无用量数据';
            board.appendChild(empty);
            return;
        }
        const range = RANGES.find((r) => r.key === currentRange) || RANGES[0];
        const rangeDays = days.slice(0, range.days);
        const today = days[0];
        // 汇总行与按模型表的数据源：今日=单日；七天/一个月=区间聚合。
        const active = range.days === 1 ? today : aggregateDays(rangeDays, range.label);
        renderUsageBars(board, rangeDays, today, alert);
        renderUsageSummary(board, active, range.days === 1 ? '今日' : range.label, alert);
        renderUsageModels(board, active);
    }

    async function loadUsageBoard() {
        try {
            const response = await fetch('/api/usage', { headers });
            if (!response.ok) throw new Error('usage http ' + response.status);
            const { data } = await response.json();
            renderUsageBoard(data);
        } catch {
            const board = document.getElementById('usageBoard');
            board.textContent = '';
            const empty = document.createElement('p');
            empty.className = 'usage-empty';
            empty.textContent = '用量数据不可用';
            board.appendChild(empty);
        }
    }
`;
