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
    });

    test('does not open file mention autocomplete for pasted boundary @ text', () => {
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
            })).toBeNull();
        }
    });
});
