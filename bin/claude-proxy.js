#!/usr/bin/env node
// claude-proxy / cc-proxy — launches a local transparent proxy, then spawns
// Claude Code with ANTHROPIC_BASE_URL pointed at it. The original
// ANTHROPIC_BASE_URL (if any) becomes the proxy's upstream.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from '../src/proxy.js';
import { createUsageStore, importJsonHistory } from '../src/usage-store.js';
import { createLatencyTracker, formatLatencySummary } from '../src/latency.js';
import { createUpstreamHealthTracker } from '../src/upstream-health.js';
import { cacheHitRate } from '../src/pricing.js';
import { readConfig } from '../src/settings.js';
import { createSystemPromptCapture, capturedSystemPromptPath } from '../src/system-prompt.js';
import { logger } from '../src/logger.js';
import { runSettingsWeb } from './settings-web.js';

const require = createRequire(import.meta.url);
const CLAUDE_BIN = process.env.CLAUDE_PROXY_BIN || 'claude';

// Crash-path logging also goes through the silent-by-default logger: Node's
// default uncaughtException/unhandledRejection handlers print stacks straight
// to stderr, which would leak into Claude Code's Ink UI via stdio inheritance.
process.on('uncaughtException', (err) => {
    logger.error('[cc-proxy] uncaught:', err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    logger.error('[cc-proxy] unhandled rejection:', err);
});

export function isDirectExecution({
    moduleUrl = import.meta.url,
    argvPath = process.argv[1],
    platform = process.platform
} = {}) {
    if (!argvPath) return false;
    try {
        const modulePath = fs.realpathSync(path.resolve(fileURLToPath(moduleUrl)));
        const entryPath = fs.realpathSync(path.resolve(argvPath));
        return platform === 'win32'
            ? modulePath.toLowerCase() === entryPath.toLowerCase()
            : modulePath === entryPath;
    } catch {
        return false;
    }
}

export async function main({
    argv = process.argv,
    runSettings = runSettingsWeb,
    readSettings = readConfig,
    createProxy = createProxyServer,
    spawnProcess = spawn,
    createTracker = createUsageStore,
    importHistory = importJsonHistory,
    createLatency = createLatencyTracker,
    warn = (msg) => logger.warn(msg)
} = {}) {
    // --version/-v: print version and exit, no proxy/claude started.
    if (argv.includes('--version') || argv.includes('-v')) {
        const { version } = require('../package.json');
        process.stdout.write(`claude-proxy ${version}\n`);
        return;
    }

    // --setting: interactive settings page, no proxy/claude started.
    if (argv.includes('--setting')) {
        return runSettings();
    }

    const originalBase = process.env.ANTHROPIC_BASE_URL;

    // 历史 usage.json 导入（design D1）：早于任何请求转发，同步串行完成。
    // 导入失败 → 本次运行强制 JSON 模式（sqliteModule: null），原文件保留。
    const importResult = await importHistory();
    const usageTracker = await createTracker(
        importResult.ok ? undefined : { sqliteModule: null }
    );
    const latencyTracker = createLatency();
    // 上游健康统计（被动埋点）：防抖落盘 ~/.cc-proxy/runtime/upstream-health.json，
    // 供设置页 /api/upstream-health 只读展示。
    const upstreamHealth = createUpstreamHealthTracker();
    const settings = readSettings();
    const { forwardSuggestionMode, thinkingAsText, effortOverride, systemPromptOverride } = settings;
    // 当日用量告警：仅当 config 配置了 alerts.dailyTokens（> 0）且当日累计
    // tokens 已超阈值时，在启动横幅前追加一条警告；未配置/未超限零输出。
    const threshold = settings?.alerts?.dailyTokens ?? 0;
    if (threshold > 0) {
        const all = usageTracker.summary();
        const todayTokens = all.inputTokens + all.outputTokens
            + all.cacheReadTokens + all.cacheCreationTokens;
        if (todayTokens > threshold) {
            warn(`[claude-proxy] WARNING: today's usage (${todayTokens} tokens) exceeds alerts.dailyTokens (${threshold})`);
        }
    }
    const server = createProxy({
        baseUrlEnv: originalBase,
        usageTracker,
        latencyTracker,
        upstreamHealth,
        forwardSuggestionMode,
        thinkingAsText,
        effortOverride,
        systemPromptOverride,
        systemPromptCapture: createSystemPromptCapture({
            file: capturedSystemPromptPath()
        }),
        // 备用上游启动时读取一次并固定（不热加载）；mock 的 settings 可能
        // 缺少该键，兜底为空数组。
        failoverUpstreams: settings.upstreams || []
    });

    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        logger.warn(`[claude-proxy] listening on http://127.0.0.1:${port} (upstream: ${originalBase || 'https://api.anthropic.com'})`);
        // 配置了备用上游时追加 failover 列表行（默认静默，CC_PROXY_LOG=1 可见）。
        const failovers = (Array.isArray(settings.upstreams) ? settings.upstreams : [])
            .filter((u) => u && typeof u === 'object' && u.baseUrl);
        if (failovers.length) {
            warn(`[claude-proxy] failover upstreams: ${failovers.map((u) => u.name).join(', ')}`);
        }

        const child = spawnProcess(CLAUDE_BIN, argv.slice(2), {
            stdio: 'inherit',
            env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }
        });

        // Ctrl+C goes to the child (it owns the terminal); the proxy shuts
        // down when the child exits. Before exiting, print a per-session
        // usage summary to stderr (via the silent-by-default logger).
        child.on('exit', (code, signal) => {
            if (logger.enabled) {
                const s = usageTracker.summary();
                const hitRate = cacheHitRate(s);
                const hitRateText = hitRate === null ? 'n/a' : `${(hitRate * 100).toFixed(1)}%`;
                warn(
                    `[claude-proxy] usage ${s.day}: ${s.requests} reqs, in ${s.inputTokens}, out ${s.outputTokens}, cache-read ${s.cacheReadTokens}, cache-create ${s.cacheCreationTokens}, cache-hit ${hitRateText}`
                );
                // 延迟汇总行：无样本（无请求或全部被拦截）时 null，不输出。
                const latencyLine = formatLatencySummary(latencyTracker.summary());
                if (latencyLine) warn(`[claude-proxy] ${latencyLine}`);
            }
            // 进程退出同步 flush 最终健康快照（绕过防抖定时器）。
            upstreamHealth.flushNow();
            server.close();
            if (signal) process.kill(process.pid, signal);
            process.exit(code ?? 0);
        });
        child.on('error', (err) => {
            logger.error(`[claude-proxy] failed to spawn ${CLAUDE_BIN}: ${err.message}`);
            server.close();
            process.exit(1);
        });
    });
}

if (isDirectExecution()) {
    Promise.resolve()
        .then(() => main())
        .catch((error) => {
            logger.error('[cc-proxy] failed:', error);
            process.exitCode = 1;
        });
}
