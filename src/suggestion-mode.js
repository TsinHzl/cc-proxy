// Suggestion Mode 拦截：识别 Claude Code 的输入建议请求并构造结构完整的
// 空响应（判据移植自 kiro2cc-proxy is_suggestion_mode_request）。
// 容错：payload 缺字段/类型不符一律不命中，绝不抛出。
export const SUGGESTION_MARKER = '[SUGGESTION MODE';

// 判据：最后一条消息为 user 且 content 以 `[SUGGESTION MODE` 开头
// （字符串 content 用 startsWith；块数组仅检查首块，避免首块为普通文本、
// 后续块恰好以标记开头时误吞整条正常消息）。
export function isSuggestionModeRequest(payload) {
    const messages = payload?.messages;
    if (!Array.isArray(messages) || !messages.length) return false;
    const last = messages[messages.length - 1];
    if (!last || typeof last !== 'object' || last.role !== 'user') return false;
    const content = last.content;
    if (typeof content === 'string') return content.startsWith(SUGGESTION_MARKER);
    if (!Array.isArray(content)) return false;
    const first = content[0];
    if (!first || typeof first !== 'object') return false;
    return first.type === 'text'
        && typeof first.text === 'string'
        && first.text.startsWith(SUGGESTION_MARKER);
}

// 空响应构造（按 stream 分流）：Claude Code 对该响应只取候选文本，空文本
// 等价于"无建议"；返回结构完整的正常响应而非错误，避免客户端把建议失败
// 当主对话故障重试。
export function buildSuggestionResponse(stream) {
    if (!stream) {
        const body = {
            id: 'msg_suggestion',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            model: 'suggestion',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: 0,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
            }
        };
        return { body: Buffer.from(JSON.stringify(body), 'utf8') };
    }

    // 流式：message_start → content_block_start(空 text) → content_block_stop
    // → message_delta(end_turn) → message_stop。usage 全 0 表示未消耗上游。
    const events = [
        {
            type: 'message_start',
            message: {
                id: 'msg_suggestion',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'suggestion',
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: 0,
                    output_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                }
            }
        },
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
        },
        { type: 'content_block_stop', index: 0 },
        {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 }
        },
        { type: 'message_stop' }
    ];
    return { events };
}
