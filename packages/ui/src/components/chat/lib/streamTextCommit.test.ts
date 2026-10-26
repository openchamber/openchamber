import { describe, expect, test } from 'bun:test';

import { commitStreamedText } from './streamTextCommit';

describe('commitStreamedText', () => {
    test('holds an incomplete short paragraph entirely', () => {
        expect(commitStreamedText('An unfinished thought abo')).toBe('');
    });

    test('holds a finished line until its paragraph ends', () => {
        expect(commitStreamedText('First line of a paragraph.\nSecond li')).toBe('');
        expect(commitStreamedText('First paragraph.\n\nSecond par')).toBe('First paragraph.\n\n');
    });

    test('reveals a list item once the next one starts', () => {
        expect(commitStreamedText('- one\n- tw')).toBe('- one\n');
        expect(commitStreamedText('- one\n- two\n')).toBe('- one\n');
        expect(commitStreamedText('1. one\n  more of one\n2. tw')).toBe('1. one\n  more of one\n');
    });

    test('holds a code fence until it closes', () => {
        expect(commitStreamedText('```py\nprint("a")\nprint("b")\n')).toBe('');
        expect(commitStreamedText('```py\nprint("a")\n```\nAfter')).toBe('```py\nprint("a")\n```\n');
        // A blank line inside a fence does not end the block.
        expect(commitStreamedText('```py\na = 1\n\nb = 2\n')).toBe('');
    });

    test('a title waits for the block it introduces', () => {
        expect(commitStreamedText('Intro.\n\n## Plan\n\nStep one is')).toBe('Intro.\n\n');
        expect(commitStreamedText('Intro.\n\n## Plan\n\nStep one.\n\n')).toBe('Intro.\n\n## Plan\n\nStep one.\n\n');
        expect(commitStreamedText('Intro.\n\n**Summary**\n\nAll go')).toBe('Intro.\n\n');
        // A paragraph that only starts bold is not a title.
        expect(commitStreamedText('**Note:** read this.\n\nMor')).toBe('**Note:** read this.\n\n');
    });

    test('a heading right after a paragraph ends that paragraph', () => {
        expect(commitStreamedText('Some text.\n## Next\n\nBody\n\n')).toBe('Some text.\n## Next\n\nBody\n\n');
        expect(commitStreamedText('Some text.\n## Nex')).toBe('Some text.\n');
    });

    test('a long open fence falls back to complete lines', () => {
        const lines = 'const value = 1234567890;\n'.repeat(80);
        const text = '```ts\n' + lines + 'const unfinis';
        expect(commitStreamedText(text)).toBe('```ts\n' + lines);
    });

    test('a long paragraph with no break is released at the last sentence', () => {
        const sentence = 'A finished sentence lives here, and it keeps going on. ';
        const text = sentence.repeat(30) + 'and an unfinished trail';
        expect(commitStreamedText(text)).toBe(sentence.repeat(30));
    });

    test('falls back to the last word boundary without sentences', () => {
        const words = 'word '.repeat(320);
        const text = words + 'unfinishe';
        expect(commitStreamedText(text)).toBe(words);
    });

    test('keeps unbreakable runs intact rather than splitting them', () => {
        const run = 'x'.repeat(1600);
        expect(commitStreamedText(run)).toBe(run);
    });

    test('never shrinks as the text grows', () => {
        const reply = [
            'Intro paragraph.',
            '',
            '## Plan',
            '',
            '- first',
            '- second',
            '',
            '```ts',
            'const x = 1;',
            '```',
            '',
            '**Done**',
            '',
            'Closing words.',
            '',
            '',
        ].join('\n');
        let previous = '';
        for (let end = 0; end <= reply.length; end += 1) {
            const committed = commitStreamedText(reply.slice(0, end));
            expect(committed.startsWith(previous)).toBe(true);
            previous = committed;
        }
        expect(previous).toBe(reply);
    });

    test('empty input stays empty', () => {
        expect(commitStreamedText('')).toBe('');
    });
});
