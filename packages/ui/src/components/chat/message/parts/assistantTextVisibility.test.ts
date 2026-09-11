import { describe, expect, test } from 'bun:test';

import {
    resolveAssistantDisplayText,
    resolveAssistantTextStreaming,
    shouldRenderAssistantText,
} from './assistantTextVisibility';

describe('resolveAssistantTextStreaming', () => {
    test('streams live text whose part is not sealed', () => {
        expect(resolveAssistantTextStreaming({
            streamPhase: 'streaming',
            chatRenderMode: 'live',
            isFinalized: false,
        })).toBe(true);
        expect(resolveAssistantTextStreaming({
            streamPhase: 'cooldown',
            chatRenderMode: 'live',
            isFinalized: false,
        })).toBe(true);
    });

    test('never streams in sorted mode', () => {
        expect(resolveAssistantTextStreaming({
            streamPhase: 'streaming',
            chatRenderMode: 'sorted',
            isFinalized: false,
        })).toBe(false);
    });

    test('releases a sealed part even while the turn stays blocked (#3277)', () => {
        // A message blocked on a pending question keeps the stream phase
        // forever; the pre-question text part is sealed (time.end is set the
        // moment the model moves on to the question) and must render in full.
        expect(resolveAssistantTextStreaming({
            streamPhase: 'streaming',
            chatRenderMode: 'live',
            isFinalized: true,
        })).toBe(false);
        expect(resolveAssistantTextStreaming({
            streamPhase: 'cooldown',
            chatRenderMode: 'live',
            isFinalized: true,
        })).toBe(false);
    });
});

describe('resolveAssistantDisplayText', () => {
    test('holds the trailing line while streaming', () => {
        const text = 'line nine, fully written\nline ten, still held';
        expect(resolveAssistantDisplayText({
            textContent: text,
            throttledTextContent: text,
            isStreaming: true,
        })).toBe('line nine, fully written\n');
    });

    test('reveals the full text once the part is not streaming', () => {
        const text = 'one\ntwo\nsealed tail without trailing newline';
        expect(resolveAssistantDisplayText({
            textContent: text,
            throttledTextContent: text,
            isStreaming: false,
        })).toBe(text);
    });
});

describe('shouldRenderAssistantText', () => {
    test('hides empty text until finalized', () => {
        expect(shouldRenderAssistantText({ displayTextContent: '', isFinalized: false })).toBe(false);
    });

    test('renders non-empty display text', () => {
        expect(shouldRenderAssistantText({ displayTextContent: 'content', isFinalized: false })).toBe(true);
        expect(shouldRenderAssistantText({ displayTextContent: 'content', isFinalized: true })).toBe(true);
    });
});
