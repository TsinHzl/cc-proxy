import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isSuggestionModeRequest,
    buildSuggestionResponse,
    SUGGESTION_MARKER
} from '../src/suggestion-mode.js';

test('isSuggestionModeRequest: string content starting with marker hits', () => {
    const payload = { messages: [{ role: 'user', content: `${SUGGESTION_MARKER}: suggest next input` }] };
    assert.equal(isSuggestionModeRequest(payload), true);
});

test('isSuggestionModeRequest: block array first text block hits', () => {
    const payload = {
        messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: [{ type: 'text', text: `${SUGGESTION_MARKER}: suggest next input` }] }
        ]
    };
    assert.equal(isSuggestionModeRequest(payload), true);
});

test('isSuggestionModeRequest: marker not at start misses', () => {
    const payload = { messages: [{ role: 'user', content: `请问 ${SUGGESTION_MARKER} 是什么？` }] };
    assert.equal(isSuggestionModeRequest(payload), false);
});

test('isSuggestionModeRequest: marker in later block misses', () => {
    const payload = {
        messages: [
            { role: 'user', content: 'hi' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: '普通开头' },
                    { type: 'text', text: `${SUGGESTION_MARKER}: x` }
                ]
            }
        ]
    };
    assert.equal(isSuggestionModeRequest(payload), false);
});

test('isSuggestionModeRequest: marker in mid-history misses (must be last message)', () => {
    const payload = {
        messages: [
            { role: 'user', content: `${SUGGESTION_MARKER}: old` },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: '真正的最新输入' }
        ]
    };
    assert.equal(isSuggestionModeRequest(payload), false);
});

test('isSuggestionModeRequest: last message assistant misses', () => {
    const payload = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: `${SUGGESTION_MARKER}: x` }] };
    assert.equal(isSuggestionModeRequest(payload), false);
});

test('isSuggestionModeRequest: malformed payloads never throw, all miss', () => {
    assert.equal(isSuggestionModeRequest(null), false);
    assert.equal(isSuggestionModeRequest({}), false);
    assert.equal(isSuggestionModeRequest({ messages: [] }), false);
    assert.equal(isSuggestionModeRequest({ messages: [{ role: 'user' }] }), false);
    assert.equal(isSuggestionModeRequest({ messages: [{ role: 'user', content: 42 }] }), false);
    assert.equal(isSuggestionModeRequest({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }), false);
});

test('buildSuggestionResponse: non-stream returns complete empty message JSON', () => {
    const { body, events } = buildSuggestionResponse(false);
    assert.equal(events, undefined);
    const parsed = JSON.parse(body.toString('utf8'));
    assert.equal(parsed.type, 'message');
    assert.equal(parsed.role, 'assistant');
    assert.deepEqual(parsed.content, [{ type: 'text', text: '' }]);
    assert.equal(parsed.stop_reason, 'end_turn');
    assert.deepEqual(parsed.usage, {
        input_tokens: 0,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    });
});

test('buildSuggestionResponse: stream returns full empty SSE event sequence', () => {
    const { body, events } = buildSuggestionResponse(true);
    assert.equal(body, undefined);
    assert.deepEqual(events.map((e) => e.type), [
        'message_start',
        'content_block_start',
        'content_block_stop',
        'message_delta',
        'message_stop'
    ]);
    const start = events[0];
    assert.deepEqual(start.message.usage, {
        input_tokens: 0,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    });
    // message_delta 固定携带 usage，与非流式语义一致。
    assert.deepEqual(events[3].usage, { output_tokens: 1 });
    assert.equal(events[3].delta.stop_reason, 'end_turn');
});
