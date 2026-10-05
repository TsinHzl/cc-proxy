#!/usr/bin/env node
// claude-proxy / cc-proxy — launches a local transparent proxy, then spawns
// Claude Code with ANTHROPIC_BASE_URL pointed at it. The original
// ANTHROPIC_BASE_URL (if any) becomes the proxy's upstream.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createProxyServer } from '../src/proxy.js';

const CLAUDE_BIN = process.env.CLAUDE_PROXY_BIN || 'claude';

function main() {
    const originalBase = process.env.ANTHROPIC_BASE_URL;

    const server = createProxyServer({ baseUrlEnv: originalBase });

    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        console.error(`[claude-proxy] listening on http://127.0.0.1:${port} (upstream: ${originalBase || 'https://api.anthropic.com'})`);

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
            console.error(`[claude-proxy] failed to spawn ${CLAUDE_BIN}: ${err.message}`);
            server.close();
            process.exit(1);
        });
    });
}

main();
