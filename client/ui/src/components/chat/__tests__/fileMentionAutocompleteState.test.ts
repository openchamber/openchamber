import { describe, expect, test } from 'bun:test';

import { getFileMentionAutocompleteQuery } from '../fileMentionAutocompleteState';

describe('getFileMentionAutocompleteQuery', () => {
    test('opens file mention autocomplete for manually typed boundary @ text', () => {
        expect(getFileMentionAutocompleteQuery({
            value: '@config',
            cursorPosition: '@config'.length,
            inputSource: 'manual',
        })).toBe('config');

        expect(getFileMentionAutocompleteQuery({
            value: 'check @main.ts',
            cursorPosition: 'check @main.ts'.length,
            inputSource: 'manual',
        })).toBe('main.ts');

        expect(getFileMentionAutocompleteQuery({
            value: 'check @docs',
            cursorPosition: 'check @docs'.length,
        })).toBe('docs');
    });

    test('does not open file mention autocomplete when pasted text contains @', () => {
        const pastedValues = [
            '@config',
            '@/path/to/file',
            'Use @main.ts',
        ];

        for (const value of pastedValues) {
            expect(getFileMentionAutocompleteQuery({
                value,
                cursorPosition: value.length,
                inputSource: 'paste',
                insertedText: value,
            })).toBeNull();
        }
    });

    test('does not open file mention autocomplete for pasted package and email text', () => {
        const pastedValues = [
            'user@email.com',
            'npx @scope/pkg@latest',
        ];

        for (const value of pastedValues) {
            expect(getFileMentionAutocompleteQuery({
                value,
                cursorPosition: value.length,
                inputSource: 'paste',
                insertedText: value,
            })).toBeNull();
        }
    });

    test('keeps autocomplete open when pasting a query fragment after a manually typed @', () => {
        expect(getFileMentionAutocompleteQuery({
            value: '@config',
            cursorPosition: '@config'.length,
            inputSource: 'paste',
            insertedText: 'config',
        })).toBe('config');
    });

    test('uses current value when paste source lacks inserted text context', () => {
        expect(getFileMentionAutocompleteQuery({
            value: '@config',
            cursorPosition: '@config'.length,
            inputSource: 'paste',
        })).toBe('config');
    });
});
