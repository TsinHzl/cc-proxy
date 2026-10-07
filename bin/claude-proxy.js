#!/usr/bin/env node
// claude-proxy / cc-proxy — launches a local transparent proxy, then spawns
// Claude Code with ANTHROPIC_BASE_URL pointed at it. The original
// ANTHROPIC_BASE_URL (if any) becomes the proxy's upstream.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createProxyServer } from '../src/proxy.js';
import { createUsageTracker } from '../src/usage.js';
import { readConfig } from '../src/settings.js';
import { logger } from '../src/logger.js';
import { runSettingsCli } from './settings-cli.js';

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

function main() {
    // --version/-v: print version and exit, no proxy/claude started.
    if (process.argv.includes('--version') || process.argv.includes('-v')) {
        const { version } = require('../package.json');
        process.stdout.write(`claude-proxy ${version}\n`);
        return;
    }

    // --setting: interactive settings page, no proxy/claude started.
    if (process.argv.includes('--setting')) {
        runSettingsCli().then(() => process.exit(0));
        return;
    }

    const originalBase = process.env.ANTHROPIC_BASE_URL;

    const usageTracker = createUsageTracker();
    // Suggestion Mode 放行开关从持久化配置读取（默认 false = 拦截建议请求）。
    const { forwardSuggestionMode } = readConfig();
    const server = createProxyServer({ baseUrlEnv: originalBase, usageTracker, forwardSuggestionMode });

    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        logger.warn(`[claude-proxy] listening on http://127.0.0.1:${port} (upstream: ${originalBase || 'https://api.anthropic.com'})`);

        const child = spawn(CLAUDE_BIN, process.argv.slice(2), {
            stdio: 'inherit',
            env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }
        });

        // Ctrl+C goes to the child (it owns the terminal); the proxy shuts
        // down when the child exits. Before exiting, print a per-session
        // usage summary to stderr (via the silent-by-default logger).
        child.on('exit', (code, signal) => {
            const s = usageTracker.summary();
            logger.warn(
                `[claude-proxy] usage ${s.day}: ${s.requests} reqs, in ${s.inputTokens}, out ${s.outputTokens}, cache-read ${s.cacheReadTokens}, cache-create ${s.cacheCreationTokens}`
            );
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

main();
