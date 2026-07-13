import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';
import { getMessageFullText, getMessagePreview, getSearchSnippet } from './messagePreview';

describe('messagePreview', () => {
    test('joins text parts with newlines and ignores non-text parts', () => {
        const parts = [
            { type: 'text', text: 'First line' },
            { type: 'file', url: 'file:///tmp/example.txt' },
            { type: 'text', text: 'Second line' },
            { type: 'text' },
        ] as Part[];

        expect(getMessageFullText(parts)).toBe('First line\nSecond line');
    });

    test('creates a single-line preview and truncates at provided max length without adding ellipsis', () => {
        const parts = [
            { type: 'text', text: 'Hello\nworld from OpenChamber' },
        ] as Part[];

        expect(getMessagePreview(parts, 11)).toBe('Hello world');
    });

    test('creates a search snippet with leading/trailing ellipses around a match', () => {
        const text = '0123456789 target abcdefghij';

        expect(getSearchSnippet(text, 'target', 3)).toBe('…89 target ab…');
    });
});
