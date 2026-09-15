import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseImeTraceOptions } from './imeTrace';

describe('parseImeTraceOptions', () => {
    test('accepts only exact opt-in values', () => {
        expect(parseImeTraceOptions('?imeTrace=1&imeEditContext=off', null)).toEqual({
            traceEnabled: true,
            editContextDisabled: true,
            traceSource: 'query',
            editContextSource: 'query',
        });
        expect(parseImeTraceOptions('?imeTrace=true&imeEditContext=0', 'true').traceEnabled).toBe(false);
    });

    test('uses local storage only for the trace flag', () => {
        expect(parseImeTraceOptions('', '1')).toMatchObject({
            traceEnabled: true,
            traceSource: 'localStorage',
            editContextDisabled: false,
        });
    });

    test('pins the installed EditContext switch', () => {
        const source = readFileSync(
            fileURLToPath(import.meta.resolve('@codemirror/view')),
            'utf8',
        ).replace(/\s+/g, '');
        expect(source).toContain('view.constructor.EDIT_CONTEXT!==false');
    });
});
