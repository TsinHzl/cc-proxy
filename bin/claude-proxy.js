#!/usr/bin/env node
// claude-proxy / cc-proxy — launches a local transparent proxy, then spawns
// Claude Code with ANTHROPIC_BASE_URL pointed at it. The original
// ANTHROPIC_BASE_URL (if any) becomes the proxy's upstream.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createProxyServer } from '../src/proxy.js';
import { readConfig } from '../src/settings.js';
import { logger } from '../src/logger.js';
import { runSettingsCli } from './settings-cli.js';

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
    // --setting: interactive settings page, no proxy/claude started.
    if (process.argv.includes('--setting')) {
        runSettingsCli().then(() => process.exit(0));
        return;
    }

    const originalBase = process.env.ANTHROPIC_BASE_URL;

    // Window size read once at startup; config edits take effect in new sessions.
    const config = readConfig(process.env.CC_PROXY_CONFIG_DIR);
    const windowLines = config.thinkingWindow?.enabled ? config.thinkingWindow.lines : 0;

    const server = createProxyServer({ baseUrlEnv: originalBase, windowLines });

    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        logger.warn(`[claude-proxy] listening on http://127.0.0.1:${port} (upstream: ${originalBase || 'https://api.anthropic.com'})`);

        const child = spawn(CLAUDE_BIN, process.argv.slice(2), {
            stdio: 'inherit',
            env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }
        });

        // Ctrl+C goes to the child (it owns the terminal); the proxy shuts
        // down when the child exits.
        child.on('exit', (code, signal) => {
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
