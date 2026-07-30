import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

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
        .map((source) => (typeof source === 'function' ? null : source))
        .find(Boolean);
    if (!set) return found;
    const iterator = set.iter();
    while (iterator.value) {
        const spec = iterator.value.spec as { class?: string };
        found.push([state.doc.sliceString(iterator.from, iterator.to), spec.class ?? '']);
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
