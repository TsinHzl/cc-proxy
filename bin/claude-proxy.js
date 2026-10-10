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
import { createUsageTracker } from '../src/usage.js';
import { readConfig } from '../src/settings.js';
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

export function main({
    argv = process.argv,
    runSettings = runSettingsWeb,
    readSettings = readConfig,
    createProxy = createProxyServer,
    spawnProcess = spawn
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

    const usageTracker = createUsageTracker();
    const { forwardSuggestionMode, thinkingAsText, effortOverride } = readSettings();
    const server = createProxy({
        baseUrlEnv: originalBase,
        usageTracker,
        forwardSuggestionMode,
        thinkingAsText,
        effortOverride
    });

    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        logger.warn(`[claude-proxy] listening on http://127.0.0.1:${port} (upstream: ${originalBase || 'https://api.anthropic.com'})`);

        const child = spawnProcess(CLAUDE_BIN, argv.slice(2), {
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

if (isDirectExecution()) {
    Promise.resolve()
        .then(() => main())
        .catch((error) => {
            logger.error('[cc-proxy] failed:', error);
            process.exitCode = 1;
        });
}
