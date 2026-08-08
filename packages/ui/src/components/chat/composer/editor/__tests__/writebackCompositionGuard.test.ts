import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for issue #2527: the chat input's cursor jumps during IME
// composition because the controlled-value writeback replaces the document
// mid-composition.
//
// While the browser composes (pinyin, kana, hangul...), the uncommitted text
// lives in the DOM, not in the CodeMirror document. The controlled-writeback
// effect compares the prop against `view.state.doc.toString()`, sees a
// mismatch, and dispatches a wholesale document replacement — interrupting
// the IME session and forcing the caret to the end. The writeback must be
// deferred for the whole composition session (CodeMirror exposes this as the
// public `compositionStarted` getter) and resume afterwards through the
// normal onChange pipeline.

const __dirname = dirname(fileURLToPath(import.meta.url));
const composerEditorSource = readFileSync(
    join(__dirname, '..', 'ComposerEditor.tsx'),
    'utf-8',
);
// The installed @codemirror/view type declarations: pin the public getter
// the guard relies on, so a dependency upgrade that renames or removes it
// fails this test instead of silently breaking the guard.
const codeMirrorViewTypes = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', '..',
        'node_modules', '@codemirror', 'view', 'dist', 'index.d.ts'),
    'utf-8',
);

const writebackEffect = (): string => {
    const start = composerEditorSource.indexOf('// Controlled value:');
    expect(start).toBeGreaterThan(-1);
    const tail = composerEditorSource.slice(start);
    const close = tail.indexOf('}, [value]);');
    expect(close).toBeGreaterThan(-1);
    return tail.slice(0, close);
};

describe('composer value writeback composition guard (issue #2527)', () => {
    test('the writeback is deferred while the view is composing', () => {
        const effect = writebackEffect();

        expect(effect).toContain('if (view.compositionStarted) return;');
        // The guard runs before the wholesale replacement, so a prop change
        // mid-composition never reaches the dispatch.
        const guardIndex = effect.indexOf('view.compositionStarted');
        const dispatchIndex = effect.indexOf('view.dispatch({');
        expect(guardIndex).toBeGreaterThan(-1);
        expect(dispatchIndex).toBeGreaterThan(guardIndex);
    });

    test('the guard uses the public compositionStarted getter of the installed CodeMirror', () => {
        expect(codeMirrorViewTypes).toContain('get compositionStarted(): boolean;');
    });

    test('the equality fast-path still guards ordinary writebacks', () => {
        const effect = writebackEffect();

        // Without composition, the existing behavior is untouched: no
        // dispatch when the prop already matches the document.
        expect(effect).toContain('if (current === value) return;');
        expect(effect).toContain('selection: { anchor: value.length }');
    });
});
