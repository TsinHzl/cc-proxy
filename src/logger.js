// Proxy-internal logging: silent by default. The proxy shares its terminal
// with claude (stdio: 'inherit'), and any bytes we print land inside Claude
// Code's Ink renderer — visibly corrupting the input box. Set CC_PROXY_LOG=1
// to restore stderr output when debugging the proxy itself.
export const logger = {
    get enabled() { return process.env.CC_PROXY_LOG === '1'; },
    warn(...args) { if (this.enabled) console.warn(...args); },
    error(...args) { if (this.enabled) console.error(...args); }
};
