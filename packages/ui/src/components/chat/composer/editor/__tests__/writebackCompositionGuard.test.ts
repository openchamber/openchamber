import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const composerEditorSource = readFileSync(
    new URL('../ComposerEditor.tsx', import.meta.url),
    'utf-8',
);

const writebackEffect = (): string => {
    const start = composerEditorSource.indexOf('// Controlled value:');
    expect(start).toBeGreaterThan(-1);
    const end = composerEditorSource.indexOf('}, [value]);', start);
    expect(end).toBeGreaterThan(start);
    return composerEditorSource.slice(start, end);
};

describe('composer value writeback composition guard (issue #2527)', () => {
    test('checks equality, then composition, before dispatching', () => {
        const effect = writebackEffect();
        const equalityCheck = effect.indexOf('if (current === value) return;');
        const compositionGuard = effect.indexOf('if (view.compositionStarted) return;');
        const dispatch = effect.indexOf('view.dispatch(');

        expect(equalityCheck).toBeGreaterThan(-1);
        expect(compositionGuard).toBeGreaterThan(equalityCheck);
        expect(dispatch).toBeGreaterThan(compositionGuard);
    });
});
