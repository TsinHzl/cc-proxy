// thinking → text 渲染核心，逐字节对齐 agy-cc-proxy src/cloudcode/thinking-text-streamer.js
import { logger } from './logger.js';

export const MAX_THINKING_TEXT_BLOCK_BYTES = 256 * 1024;
export const MAX_THINKING_TEXT_RESPONSE_BYTES = 1024 * 1024;

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
// Style: dim wraps each line individually and resets before every newline so
// styling never spans lines. No `> ` prefix: a dim plain line avoids the
// blockquote bar Claude Code renders for quoted lines.
const THINKING_TEXT_HEADER_LINE = `${ANSI_DIM}💭 Thinking${ANSI_RESET}`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const THINKING_TEXT_LINE_RE = `\\n${escapeRegExp(ANSI_DIM)}[^\\n]*?${escapeRegExp(ANSI_RESET)}`;
const THINKING_TEXT_BLOCK_RE = new RegExp(
    `${escapeRegExp(THINKING_TEXT_HEADER_LINE)}(?:${THINKING_TEXT_LINE_RE})*`,
    'g'
);
// Legacy marker-prefixed format (whole-block dim + invisible marker) kept so
// history rendered by older versions is still stripped from conversations.
const LEGACY_THINKING_TEXT_PREFIX = `${ANSI_DIM}> 💭 Thinking⁣agy-thinking-text-v1⁣`;
const LEGACY_THINKING_TEXT_BLOCK_RE = new RegExp(
    `${escapeRegExp(LEGACY_THINKING_TEXT_PREFIX)}\\n?(?:> [^\\r\\n]*(?:\\r?\\n|(?=${escapeRegExp(ANSI_RESET)})))*${escapeRegExp(ANSI_RESET)}`,
    'g'
);
// Previous blockquote format (`> ` prefix per line, no marker) so history
// rendered before the bar-less style is still stripped from conversations.
const QUOTED_THINKING_TEXT_HEADER_LINE = `> ${ANSI_DIM}💭 Thinking${ANSI_RESET}`;
const QUOTED_THINKING_TEXT_BLOCK_RE = new RegExp(
    `${escapeRegExp(QUOTED_THINKING_TEXT_HEADER_LINE)}(?:\\n> [^\\n]*?${escapeRegExp(ANSI_RESET)})*`,
    'g'
);

// Same pattern as agy-cc-proxy src/server/routes-messages.js:17
export const CLAUDE_CODE_UA_RE = /^(?:claude-cli|claude-code)(?:\/|\s|$)/i;

export function isClaudeCodeUserAgent(userAgent) {
    return typeof userAgent === 'string' && CLAUDE_CODE_UA_RE.test(userAgent);
}

export function formatThinkingAsText(thinking) {
    if (!thinking) return null;

    const quotedThinking = thinking
        .replace(/\r\n?/g, '\n')
        // Trailing newlines would render an empty blockquote line (the stray
        // extra segment of the left quote bar), so drop them.
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line)
        .map((line) => `${ANSI_DIM}${line}${ANSI_RESET}`)
        .join('\n');
    // No trailing newline: a block-ending '\n' makes Claude Code render one
    // blockquote line more than the text (matches kiro2cc-proxy thinking_text.rs).
    if (!quotedThinking) return THINKING_TEXT_HEADER_LINE;
    return `${THINKING_TEXT_HEADER_LINE}\n${quotedThinking}`;
}

// Duration summary appended as the final line when a thinking block stops, e.g.
// `💭 Thought for 12s` or `💭 Thought for 1m16s` (whole seconds with a 1s floor,
// <60s shows `Xs`, ≥60s shows `XmYs`; matching agy-cc-proxy thinking-text-streamer.js).
export function formatDurationLine(seconds) {
    const total = Math.max(1, Math.round(seconds));
    const label = total < 60
        ? `${total}s`
        : `${Math.floor(total / 60)}m${total % 60}s`;
    return `${ANSI_DIM}💭 Thought for ${label}${ANSI_RESET}`;
}

export function stripThinkingTextHistory(messages) {
    if (!Array.isArray(messages)) return messages;

    return messages.map((message) => {
        if (message?.role !== 'assistant') return message;

        if (typeof message.content === 'string') {
            return {
                ...message,
                content: message.content
                    // Quoted format first: the bare-format regex would otherwise
                    // match the dim header inside a quoted block and break it up.
                    .replace(QUOTED_THINKING_TEXT_BLOCK_RE, '')
                    .replace(THINKING_TEXT_BLOCK_RE, '')
                    .replace(LEGACY_THINKING_TEXT_BLOCK_RE, '')
            };
        }

        if (!Array.isArray(message.content)) return message;

        const content = message.content.flatMap((block) => {
            if (block?.type !== 'text' || typeof block.text !== 'string') return [block];
            const text = block.text
                // Quoted format first: see strip order note above.
                .replace(QUOTED_THINKING_TEXT_BLOCK_RE, '')
                .replace(THINKING_TEXT_BLOCK_RE, '')
                .replace(LEGACY_THINKING_TEXT_BLOCK_RE, '');
            return text ? [{ ...block, text }] : [];
        });
        return { ...message, content };
    });
}

function isThinkingStart(event) {
    return event.type === 'content_block_start' && event.content_block?.type === 'thinking';
}

function isMatchingThinkingDelta(event, index) {
    return event.type === 'content_block_delta' &&
        event.index === index &&
        event.delta?.type === 'thinking_delta';
}

function isMatchingSignatureDelta(event, index) {
    return event.type === 'content_block_delta' &&
        event.index === index &&
        event.delta?.type === 'signature_delta';
}

function isMatchingStop(event, index) {
    return event.type === 'content_block_stop' && event.index === index;
}

/**
 * Converts Anthropic thinking event blocks to Claude Code text blocks.
 * Events not related to a thinking block pass through unchanged.
 *
 * @param {AsyncIterable<Object>} events - Anthropic-format SSE events
 * @param {{thinkingAsText?: boolean}} options
 * @yields {Object} Anthropic-format SSE events
 */
export async function* transformThinkingAsTextEvents(events, options = {}) {
    if (options.thinkingAsText !== true) {
        yield* events;
        return;
    }

    let pendingBlock = null;
    let responseThinkingBytes = 0;
    let responseLimitExceeded = false;
    let blockStartedAtMs = null;

    const textDeltaEvent = (index, text) => ({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text }
    });

    // Emit buffered complete lines as they arrive so the thinking text streams
    // out incrementally instead of appearing all at once at content_block_stop.
    // The content_block_start is emitted lazily with the first line so deltas
    // never precede their block start.
    const flushCompleteLines = function* (block) {
        let newlineIndex;
        while ((newlineIndex = block.pending.indexOf('\n')) !== -1) {
            const line = block.pending.slice(0, newlineIndex).replace(/\r$/, '').trim();
            block.pending = block.pending.slice(newlineIndex + 1);
            // Skip blank lines: an empty quote line renders as a stray extra
            // segment of the left blockquote bar in Claude Code.
            if (!line) continue;
            if (!block.started) {
                block.started = true;
                yield {
                    type: 'content_block_start',
                    index: block.index,
                    content_block: { type: 'text', text: '' }
                };
            }
            if (block.firstChunk) {
                block.firstChunk = false;
                yield textDeltaEvent(block.index, THINKING_TEXT_HEADER_LINE);
            }
            // Newline leads the next line instead of trailing the previous one,
            // so the block never ends with '\n' (an extra empty blockquote line
            // rendering as a stray segment of the left quote bar) — kiro style.
            yield textDeltaEvent(block.index, `\n${ANSI_DIM}${line}${ANSI_RESET}`);
        }
    };

    const discardPendingBlock = (reason) => {
        if (!pendingBlock || pendingBlock.discarded) return;
        logger.warn(`[cc-proxy] dropping thinking text block index=${pendingBlock.index} reason=${reason} blockBytes=${pendingBlock.bytes} responseBytes=${responseThinkingBytes}`);
        pendingBlock.thinking = '';
        pendingBlock.pending = '';
        pendingBlock.discarded = true;
    };

    for await (const event of events) {
        // Ping/pong 心跳事件透传，但绝不重置当前 thinking 块的跟踪状态：
        // 真实上游（如部分网关）会在 thinking 块中途插发 ping，若在此处
        // 丢失 pendingBlock，后续 signature_delta/stop 会作为孤儿事件泄漏
        // 给客户端（content_block_delta 先于 content_block_start，CC 解析
        // 中断后表现为"请求成功但收不到回复"）。
        if (event.type === 'ping') {
            yield event;
            continue;
        }

        if (pendingBlock) {
            if (isMatchingThinkingDelta(event, pendingBlock.index)) {
                const thinkingDelta = event.delta.thinking || '';
                const deltaBytes = Buffer.byteLength(thinkingDelta, 'utf8');
                responseThinkingBytes += deltaBytes;

                if (responseThinkingBytes > MAX_THINKING_TEXT_RESPONSE_BYTES) {
                    responseLimitExceeded = true;
                    discardPendingBlock('response_limit');
                } else if (pendingBlock.bytes + deltaBytes > MAX_THINKING_TEXT_BLOCK_BYTES) {
                    discardPendingBlock('block_limit');
                } else if (!pendingBlock.discarded) {
                    pendingBlock.thinking += thinkingDelta;
                    pendingBlock.bytes += deltaBytes;
                    pendingBlock.pending += thinkingDelta;
                    yield* flushCompleteLines(pendingBlock);
                    if (responseThinkingBytes === MAX_THINKING_TEXT_RESPONSE_BYTES) {
                        responseLimitExceeded = true;
                    }
                }
                continue;
            }

            if (isMatchingSignatureDelta(event, pendingBlock.index)) {
                // Signature is dropped: rendered text blocks carry no signature.
                continue;
            }

            if (isMatchingStop(event, pendingBlock.index)) {
                const elapsedLine = blockStartedAtMs === null
                    ? null
                    : formatDurationLine((Date.now() - blockStartedAtMs) / 1000);
                blockStartedAtMs = null;
                if (!pendingBlock.discarded && pendingBlock.thinking) {
                    // Newline leads, never trails; blank lines are skipped so
                    // the block ends right after ANSI_RESET with no extra
                    // empty quote line.
                    const lastLine = pendingBlock.pending.replace(/\r$/, '').trim();
                    let tail = '';
                    if (lastLine) {
                        tail = `${pendingBlock.firstChunk ? THINKING_TEXT_HEADER_LINE : ''}\n${ANSI_DIM}${lastLine}${ANSI_RESET}`;
                        pendingBlock.pending = '';
                    }
                    if (tail && elapsedLine) tail += `\n${elapsedLine}`;
                    // Whitespace-only block with nothing emitted: skip the
                    // stop event too, so the client never sees an orphan
                    // content_block_stop without its content_block_start.
                    if (pendingBlock.started || tail) {
                        pendingBlock.firstChunk = false;
                        if (!pendingBlock.started) {
                            yield {
                                type: 'content_block_start',
                                index: pendingBlock.index,
                                content_block: { type: 'text', text: '' }
                            };
                            pendingBlock.started = true;
                        }
                        if (tail) {
                            yield textDeltaEvent(pendingBlock.index, tail);
                        } else if (elapsedLine && pendingBlock.started) {
                            // Fully flushed block (pending empty at stop): no
                            // tail text left; newline still leads so the
                            // duration line starts fresh (byte-compatible with
                            // agy-cc-proxy).
                            yield textDeltaEvent(pendingBlock.index, `\n${elapsedLine}`);
                        }
                        yield event;
                    }
                } else if (pendingBlock.started) {
                    // Partially streamed block got discarded (block/response limit) —
                    // lines already end with resets; just close with its stop event.
                    yield event;
                }
                pendingBlock = null;
                continue;
            }

            pendingBlock = null;
        }

        if (isThinkingStart(event)) {
            blockStartedAtMs = Date.now();
            pendingBlock = {
                index: event.index,
                thinking: '',
                pending: '',
                firstChunk: true,
                started: false,
                bytes: 0,
                discarded: responseLimitExceeded
            };
            if (responseLimitExceeded) {
                discardPendingBlock('response_limit');
            }
            continue;
        }

        yield event;
    }
}
