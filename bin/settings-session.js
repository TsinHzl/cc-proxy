export const SESSION_TIMING = Object.freeze({
    heartbeatMs: 10_000,
    disconnectGraceMs: 2_000,
    firstConnectionTimeoutMs: 30_000,
    closeTimeoutMs: 1_000
});

function commonHeaders(extra = {}) {
    return {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...extra
    };
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, commonHeaders({
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body)
    }));
    res.end(body);
}

function createLifecycleState({
    server,
    disconnectGraceMs,
    closeTimeoutMs,
    scheduleTimeout,
    cancelTimeout,
    cancelInterval
}) {
    let resolveFinished;
    const finished = new Promise((resolve) => {
        resolveFinished = resolve;
    });
    return {
        server,
        disconnectGraceMs,
        closeTimeoutMs,
        scheduleTimeout,
        cancelTimeout,
        cancelInterval,
        leases: new Map(),
        sockets: new Set(),
        socketCloseListeners: new Map(),
        graceTimer: null,
        closeFallbackTimer: null,
        firstConnectionTimer: null,
        heartbeatTimer: null,
        closing: false,
        settled: false,
        resolveFinished,
        finished,
        onConnection: null,
        finish: null
    };
}

function trackSocket(state, socket) {
    if (state.sockets.has(socket)) return;
    const onSocketClose = () => {
        state.sockets.delete(socket);
        state.socketCloseListeners.delete(socket);
    };
    state.sockets.add(socket);
    state.socketCloseListeners.set(socket, onSocketClose);
    socket.once('close', onSocketClose);
}

function settleLifecycle(state) {
    if (state.settled) return;
    state.settled = true;
    state.cancelTimeout(state.closeFallbackTimer);
    state.server.removeListener?.(
        'connection',
        state.onConnection
    );
    for (const [socket, onSocketClose]
        of state.socketCloseListeners) {
        socket.removeListener?.('close', onSocketClose);
    }
    state.socketCloseListeners.clear();
    state.sockets.clear();
    state.resolveFinished();
}

function forceCloseSockets(state) {
    for (const socket of [...state.sockets]) {
        try {
            socket.destroy();
        } catch {
            // Continue destroying remaining sockets.
        }
    }
    settleLifecycle(state);
}

function finishLifecycle(state) {
    if (state.closing) return;
    state.closing = true;
    state.cancelTimeout(state.firstConnectionTimer);
    state.cancelTimeout(state.graceTimer);
    state.cancelInterval(state.heartbeatTimer);
    for (const response of state.leases.keys()) {
        try {
            response.end();
        } catch {
            // Continue closing remaining responses.
        }
    }
    state.leases.clear();
    state.closeFallbackTimer = state.scheduleTimeout(
        () => forceCloseSockets(state),
        state.closeTimeoutMs
    );
    try {
        state.server.close(() => settleLifecycle(state));
    } catch {
        settleLifecycle(state);
    }
}

function heartbeatLeases(state) {
    for (const [response, release] of [...state.leases]) {
        try {
            response.write(': ping\n\n');
        } catch {
            release();
            try {
                response.end();
            } catch {
                // The lease is already released.
            }
        }
    }
}

function openLease(state, res) {
    if (state.closing) {
        sendJson(res, 503, {
            ok: false,
            error: '设置服务正在关闭'
        });
        return;
    }
    state.cancelTimeout(state.firstConnectionTimer);
    state.cancelTimeout(state.graceTimer);
    state.graceTimer = null;

    let released = false;
    const release = () => {
        if (released || state.closing) return;
        released = true;
        state.leases.delete(res);
        if (state.leases.size === 0) {
            state.cancelTimeout(state.graceTimer);
            state.graceTimer = state.scheduleTimeout(
                state.finish,
                state.disconnectGraceMs
            );
        }
    };
    state.leases.set(res, release);
    res.once('close', release);
    res.on('error', release);

    try {
        res.writeHead(200, commonHeaders({
            'content-type': 'text/event-stream; charset=utf-8',
            connection: 'keep-alive'
        }));
        res.write(': connected\n\n');
    } catch {
        release();
        try {
            res.end();
        } catch {
            // The lease is already released.
        }
    }
}

export function createSessionLifecycle({
    server,
    heartbeatMs = SESSION_TIMING.heartbeatMs,
    disconnectGraceMs = SESSION_TIMING.disconnectGraceMs,
    firstConnectionTimeoutMs =
        SESSION_TIMING.firstConnectionTimeoutMs,
    closeTimeoutMs = SESSION_TIMING.closeTimeoutMs,
    scheduleTimeout = setTimeout,
    cancelTimeout = clearTimeout,
    scheduleInterval = setInterval,
    cancelInterval = clearInterval
}) {
    const state = createLifecycleState({
        server,
        disconnectGraceMs,
        closeTimeoutMs,
        scheduleTimeout,
        cancelTimeout,
        cancelInterval
    });
    state.onConnection = (socket) => trackSocket(state, socket);
    state.finish = () => finishLifecycle(state);
    server.on?.('connection', state.onConnection);
    state.firstConnectionTimer = scheduleTimeout(
        state.finish,
        firstConnectionTimeoutMs
    );
    state.heartbeatTimer = scheduleInterval(
        () => heartbeatLeases(state),
        heartbeatMs
    );

    return {
        onSession: (_req, res) => openLease(state, res),
        close: state.finish,
        finished: state.finished
    };
}
