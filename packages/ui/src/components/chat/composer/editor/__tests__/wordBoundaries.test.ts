import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';

import { wordRangeAt } from '../wordBoundaries';

const selectedText = (doc: string, pos: number) => {
    const state = EditorState.create({ doc });
    const range = wordRangeAt(state, pos);
    return range ? doc.slice(range.from, range.to) : null;
};

describe('wordRangeAt', () => {
    test('selects the English word inside a mixed Chinese sentence', () => {
        expect(selectedText('检查openchamber的配置', 4)).toBe('openchamber');
    });

    test('selects the whole Chinese run, not the adjacent Latin word', () => {
        expect(selectedText('检查openchamber的配置', 0)).toBe('检查');
    });

    test('selects a Chinese run surrounded by Latin on both sides', () => {
        expect(selectedText('foo的bar', 3)).toBe('的');
    });

    test('selects the trailing Chinese run up to the Latin boundary', () => {
        expect(selectedText('检查openchamber的配置', 14)).toBe('的配置');
    });

    test('keeps digits and underscores with the Latin word', () => {
        expect(selectedText('var_name2', 1)).toBe('var_name2');
    });

    test('keeps accented Latin letters inside the word', () => {
        expect(selectedText('café', 1)).toBe('café');
        expect(selectedText('über', 3)).toBe('über');
        expect(selectedText('Straße', 2)).toBe('Straße');
        expect(selectedText('señor', 2)).toBe('señor');
    });

    test('keeps a decomposed accent with its base letter', () => {
        expect(selectedText('cafe\u0301', 1)).toBe('cafe\u0301');
    });

    test('still splits accented Latin from Chinese', () => {
        expect(selectedText('检查café的配置', 4)).toBe('café');
    });

    test('treats whitespace as its own class', () => {
        expect(selectedText('a b', 1)).toBe(' ');
    });

    test('returns null on an empty line', () => {
        expect(selectedText('', 0)).toBeNull();
    });
});
