import { describe, expect, test } from 'bun:test';
import type { ContextPartPayload } from './contextParts';
import { getQueuedMessagePreview } from './queuedMessagePreview';

const preview = (payload: ContextPartPayload, content = '') => getQueuedMessagePreview({
    content,
    context: [{ kind: 'context', text: 'Model-facing wrapper', metadata: { openchamberContext: payload } }],
});

describe('queued message preview', () => {
    test('shows comments from chat, files, browser, and PR context without composer text', () => {
        const payloads: ContextPartPayload[] = [
            { kind: 'chat-quote', quote: 'Quoted answer', text: 'Please explain this' },
            { kind: 'file-quote', fileLabel: 'a.ts', quote: 'const a = 1', text: 'Please explain this' },
            { kind: 'code-comment', source: 'diff', fileLabel: 'a.ts', startLine: 1, endLine: 1, language: 'ts', code: 'const a = 1', text: 'Please explain this' },
            { kind: 'browser-annotation', pageUrl: 'https://example.com', prompt: 'Selected element', text: 'Please explain this' },
            { kind: 'pr-comment', label: 'PR #1', body: 'Review comment', text: 'Please explain this' },
            { kind: 'pr-check', label: 'Type check', output: 'Error', text: 'Please explain this' },
        ];
        for (const payload of payloads) {
            expect(preview(payload)).toBe('Please explain this');
            expect(preview(payload, 'My prompt')).toBe('My prompt');
        }
    });

    test('uses quotes, terminal output, and linked titles when there is no comment', () => {
        expect(preview({ kind: 'chat-quote', quote: 'Quoted answer', text: ' ' })).toBe('Quoted answer');
        expect(preview({ kind: 'terminal', terminalId: 't', terminalLabel: 'Shell', startLine: 1, endLine: 1, output: 'Build failed' })).toBe('Build failed');
        expect(preview({ kind: 'github-issue', number: 1, title: 'Fix login', url: 'https://example.com' })).toBe('Fix login');
        expect(preview({ kind: 'linear-issue', identifier: 'ENG-1', title: 'Fix login', url: 'https://example.com' })).toBe('Fix login');
    });

    test('uses server summaries and skips empty context and derived instructions', () => {
        expect(getQueuedMessagePreview({ content: ' \n ', contextPreview: 'Attached comment' })).toBe('Attached comment');
        expect(getQueuedMessagePreview({ content: '', context: [
            { kind: 'instruction', text: 'Use this skill' },
            { kind: 'synthetic', text: ' ' },
            { kind: 'synthetic', text: 'Resolve conflicts' },
        ] })).toBe('Resolve conflicts');
        expect(getQueuedMessagePreview({ content: '' })).toBe('');
    });

    test('bounds long and multiline previews, including already truncated server summaries', () => {
        expect(getQueuedMessagePreview({ content: '\n First line\nSecond line' })).toBe('First line...');
        const long = 'a'.repeat(120);
        const summary = getQueuedMessagePreview({ content: long });
        expect(summary).toBe('a'.repeat(100) + '...');
        expect(getQueuedMessagePreview({ content: '', contextPreview: summary })).toBe(summary);
    });
});
