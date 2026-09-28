import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { Direction, EditorView } from '@codemirror/view';

import type { ComposerLanguageContext } from '../../language/tokenize';
import { composerLanguage, setLanguageContext } from '../composerLanguage';

const context = (overrides: Partial<ComposerLanguageContext> = {}): ComposerLanguageContext => ({
    inputMode: 'normal',
    knownAgentNames: new Set(['build']),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(['review']),
    knownSnippetTriggers: new Set(['sig']),
    attachmentFilenames: [],
    ...overrides,
});

const stateWith = (doc: string, ctx = context()) =>
    EditorState.create({ doc, extensions: composerLanguage(ctx) });

/** Every decorated stretch as [text, class]. */
const decorations = (state: EditorState) => {
    const found: Array<[string, string]> = [];
    const set = state.facet(EditorView.decorations)
        .map((source) => (source instanceof Function ? null : source))
        .find(Boolean);
    if (!set) return found;
    const iterator = set.iter();
    while (iterator.value) {
        found.push([state.doc.sliceString(iterator.from, iterator.to), iterator.value.spec.class ?? '']);
        iterator.next();
    }
    return found;
};

const decoratedText = (state: EditorState) => decorations(state).map(([text]) => text);

describe('composerLanguage — initial decorations', () => {
    test('decorates the references it knows about', () => {
        expect(decoratedText(stateWith('ask @build to /review'))).toEqual(['@build', '/review']);
    });

    test('leaves unknown tokens undecorated', () => {
        expect(decoratedText(stateWith('ask @stranger to /nothing'))).toEqual([]);
    });

    test('decorates markdown structure', () => {
        expect(decoratedText(stateWith('# Title'))).toEqual(['#', 'Title']);
    });

    test('plain prose gets no decorations at all', () => {
        expect(decoratedText(stateWith('just a sentence'))).toEqual([]);
    });

    test('an empty document is fine', () => {
        expect(decoratedText(stateWith(''))).toEqual([]);
    });

    test('shell mode disables the language', () => {
        expect(decoratedText(stateWith('@build /review', context({ inputMode: 'shell' }))))
            .toEqual([]);
    });

    test('decorated spans carry the shared highlight classes', () => {
        const [[, agentClass]] = decorations(stateWith('@build'));
        expect(agentClass).toContain('status-success');
    });
});

describe('composerLanguage — updates', () => {
    test('editing the document retokenizes', () => {
        const state = stateWith('hello');
        const next = state.update({
            changes: { from: 5, insert: ' @build' },
        }).state;
        expect(decoratedText(next)).toEqual(['@build']);
    });

    test('deleting a reference removes its decoration', () => {
        const state = stateWith('@build hi');
        const next = state.update({ changes: { from: 0, to: 7 } }).state;
        expect(decoratedText(next)).toEqual([]);
    });

    test('a new registry repaints without touching the document', () => {
        const state = stateWith('ask @deploy');
        expect(decoratedText(state)).toEqual([]);

        const next = state.update({
            effects: setLanguageContext.of(context({ knownAgentNames: new Set(['deploy']) })),
        }).state;
        expect(decoratedText(next)).toEqual(['@deploy']);
        expect(next.doc.toString()).toBe('ask @deploy');
    });

    test('a transaction that changes neither keeps the same decoration set', () => {
        const state = stateWith('@build');
        const next = state.update({ selection: { anchor: 0 } }).state;
        expect(decoratedText(next)).toEqual(['@build']);
    });

    test('the document stays the plain string that gets sent', () => {
        const state = stateWith('# Title\n@build /review #sig');
        expect(state.doc.toString()).toBe('# Title\n@build /review #sig');
    });
});

describe('composerLanguage — bidirectional technical fragments', () => {
    const isolatedText = (state: EditorState) => {
        const found: string[] = [];
        for (const source of state.facet(EditorView.bidiIsolatedRanges)) {
            if (source instanceof Function) throw new Error('Expected state-owned isolates');
            for (const cursor = source.iter(); cursor.value; cursor.next()) {
                expect(cursor.value.spec.bidiIsolate).toBe(Direction.LTR);
                found.push(state.doc.sliceString(cursor.from, cursor.to));
            }
        }
        return found;
    };

    test('keeps inline code and references intact inside Arabic prose', () => {
        const text = 'مرحبا `fn(1);` @build /review';
        const state = stateWith(text);
        expect(isolatedText(state)).toEqual(['`fn(1);`', '@build', '/review']);
        expect(state.doc.toString()).toBe(text);
    });

    test('syntax colors and nested references do not split a fenced code line', () => {
        const state = stateWith('```js\n// مرحبا @build\nconst value = 1;\n```');
        expect(isolatedText(state)).toEqual(['```js', '// مرحبا @build\nconst value = 1;', '```']);
    });

    test('removing code delimiters removes the isolation', () => {
        const state = stateWith('`مرحبا`');
        const next = state.update({ changes: [{ from: 0, to: 1 }, { from: 6, to: 7 }] }).state;
        expect(isolatedText(next)).toEqual([]);
        expect(next.doc.toString()).toBe('مرحبا');
    });

    test('shell input remains one LTR context and switching back releases it', () => {
        const text = 'echo مرحبا;';
        const state = stateWith(text, context({ inputMode: 'shell' }));
        expect(isolatedText(state)).toEqual([text]);
        const next = state.update({ effects: setLanguageContext.of(context()) }).state;
        expect(isolatedText(next)).toEqual([]);
    });

    test('selection-only transactions reuse the direction ranges', () => {
        const state = stateWith('مرحبا `fn();`');
        const next = state.update({ selection: { anchor: 3 } }).state;
        expect(next.facet(EditorView.bidiIsolatedRanges)[0]).toBe(state.facet(EditorView.bidiIsolatedRanges)[0]);
    });
});
