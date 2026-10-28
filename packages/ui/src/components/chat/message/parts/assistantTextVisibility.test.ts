import { describe, expect, test } from 'bun:test';

import {
    resolveAssistantDisplayText,
    resolveAssistantTextStreaming,
} from './assistantTextVisibility';

describe('resolveAssistantTextStreaming', () => {
    test('streams live text whose part is not sealed', () => {
        expect(resolveAssistantTextStreaming({
            streamPhase: 'streaming',
            isFinalized: false,
        })).toBe(true);
        expect(resolveAssistantTextStreaming({
            streamPhase: 'cooldown',
            isFinalized: false,
        })).toBe(true);
    });

    test('releases a sealed part even while the turn stays blocked (#3277)', () => {
        // A message blocked on a pending question keeps the stream phase
        // forever; the pre-question text part is sealed (time.end is set the
        // moment the model moves on to the question) and must render in full.
        expect(resolveAssistantTextStreaming({
            streamPhase: 'streaming',
            isFinalized: true,
        })).toBe(false);
        expect(resolveAssistantTextStreaming({
            streamPhase: 'cooldown',
            isFinalized: true,
        })).toBe(false);
    });
});

describe('resolveAssistantDisplayText', () => {
    test('holds the unfinished block while streaming', () => {
        const text = 'line nine, fully written\n\nline ten, still held';
        expect(resolveAssistantDisplayText({
            textContent: text,
            throttledTextContent: text,
            isStreaming: true,
        }).content).toBe('line nine, fully written\n\n');
    });

    test('reveals the full text once the part is not streaming', () => {
        const text = 'one\ntwo\nsealed tail without trailing newline';
        expect(resolveAssistantDisplayText({
            textContent: text,
            throttledTextContent: text,
            isStreaming: false,
        }).content).toBe(text);
    });

    test('authorized OpenUI reveals the current program while ordinary Markdown keeps its block hold', () => {
        const open = 'Intro.\n\n```openui-lang\nroot = Stack([TextContent("Partial';
        const display = (text: string, allowOpenUI = true) => resolveAssistantDisplayText({
            textContent: text, throttledTextContent: text, isStreaming: true, allowOpenUI,
        }).content;
        expect(display(open)).toBe(open);
        expect(display(open, false)).toBe('Intro.\n\n');
        const closed = open + '")])\n```';
        expect(display(closed)).toBe(closed);
        expect(display(closed + '\n\nStill typing')).toBe(closed + '\n');
        for (const source of [
            open.replace('openui-lang', 'openui-lang literal'),
            open.replace('openui-lang', 'openui-lang title="example"'),
            open.replace('openui-lang', 'typescript'),
        ]) expect(display(source)).toBe('Intro.\n\n');
    });

    test('OpenUI reveal uses the same normalized coordinates as its fence parser', () => {
        const normalized = 'Intro.\n\n```openui-lang\nroot = Stack([])\n```';
        for (const source of [normalized.replaceAll('\n', '\r\n'), `\uFEFF${normalized}`, `\uFEFF${normalized.replaceAll('\n', '\r\n')}`]) {
            expect(resolveAssistantDisplayText({
                textContent: source, throttledTextContent: source, isStreaming: true, allowOpenUI: true,
            }).content).toBe(normalized);
        }
    });
});
