import { describe, expect, test } from 'bun:test';

import { ensureLineTerminalPunctuation, sanitizeForTTS } from './summarize';

describe('sanitizeForTTS', () => {
    test('strips markdown but keeps line structure', () => {
        const text = [
            '## What is Qwen TTS',
            '',
            'Some **bold** text with `inline code`.',
        ].join('\n');
        expect(sanitizeForTTS(text)).toBe('What is Qwen TTS\nSome bold text with inline code.');
    });

    test('collapses blank lines and horizontal whitespace runs', () => {
        expect(sanitizeForTTS('a\n\n\nb   c\t\td')).toBe('a\nb c d');
        expect(sanitizeForTTS('a \n\n b')).toBe('a\nb');
    });

    test('normalizes CRLF line breaks', () => {
        expect(sanitizeForTTS('first line\r\nsecond line')).toBe('first line\nsecond line');
    });
});

describe('ensureLineTerminalPunctuation', () => {
    test('appends a period to lines ending with a letter or digit', () => {
        expect(ensureLineTerminalPunctuation('Заголовок без точки\nSecond line')).toBe(
            'Заголовок без точки.\nSecond line.',
        );
        expect(ensureLineTerminalPunctuation('Проверил 3')).toBe('Проверил 3.');
    });

    test('leaves lines with terminal punctuation or closers unchanged', () => {
        const text = ['Готово.', 'Правда?', 'Список:', '(скобка)', '«цитата»', 'слово,'].join('\n');
        expect(ensureLineTerminalPunctuation(text)).toBe(text);
    });

    test('preserves blank lines between punctuated lines', () => {
        expect(ensureLineTerminalPunctuation('a\n\nb')).toBe('a.\n\nb.');
    });
});
