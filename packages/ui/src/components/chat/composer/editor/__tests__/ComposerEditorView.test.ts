import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EditorView } from '@codemirror/view';
import { ComposerEditorView } from '../ComposerEditorView';

describe('ComposerEditorView', () => {
    test('isolates the composer EditContext opt-out', () => {
        expect(ComposerEditorView.EDIT_CONTEXT).toBe(false);
        expect(Object.getOwnPropertyDescriptor(EditorView, 'EDIT_CONTEXT')?.value).not.toBe(false);

        const source = readFileSync(
            fileURLToPath(new URL('../ComposerEditor.tsx', import.meta.url)),
            'utf8',
        );
        expect(source).toContain('new ComposerEditorView(');
        expect(source).not.toContain('new EditorView({');
    });
});
