import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { ComposerEditor, type ComposerChange, type ComposerEditorHandle } from '../ComposerEditor';
import type { ComposerLanguageContext } from '../../language/tokenize';
import { createComposerEditorViewStore } from '../viewStore';

const languageContext: ComposerLanguageContext = {
    inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(),
    knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [],
};

// The git conflict prompt ends with the `# Conflicts:` lines git writes into
// MERGE_MSG; its last line is a `#` token at the caret.
const conflictPrompt = "Preserve the intent of changes from MERGE_HEAD\n\n# Conflicts:\n#\tnotes.txt";

describe('composer change reports text set through the value prop', () => {
    let browser: Window;
    let root: Root;
    let host: HTMLDivElement;
    let descriptors: Map<string, PropertyDescriptor | undefined>;
    let changes: ComposerChange[];
    const editor = React.createRef<ComposerEditorHandle>();

    const render = (value: string, valueRevision?: number, historyRevision?: number) => act(async () => root.render(
        <ComposerEditor ref={editor} value={value} valueRevision={valueRevision} historyRevision={historyRevision}
            languageContext={languageContext} onChange={(change) => { changes.push(change); }} />,
    ));
    const undoOnce = () => act(async () => {
        const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!);
        if (view) undo(view);
    });

    beforeEach(async () => {
        browser = new Window();
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        };
        descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        host = document.createElement('div'); document.body.append(host); root = createRoot(host);
        changes = [];
        await render('');
    });

    afterEach(async () => {
        await act(async () => root.unmount()); browser.close();
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    test('a prompt handed in through value is marked as set by the app', async () => {
        await render(conflictPrompt);
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ value: conflictPrompt, fromValueProp: true });
    });

    test('text inserted at the caret is not marked', async () => {
        await render(conflictPrompt);
        await act(async () => editor.current?.insertText('\n#'));
        expect(changes).toHaveLength(2);
        expect(changes[1]).toMatchObject({ value: `${conflictPrompt}\n#`, fromValueProp: false });
    });

    // ChatInput does not render on keystrokes, so the text it puts in can be
    // the one it last rendered while the document has moved on since.
    test('a new revision writes a value equal to the last rendered one', async () => {
        await render('draft', 1);
        await act(async () => editor.current?.insertText(' typed'));
        expect(editor.current?.getValue()).toBe('draft typed');
        await render('draft', 2);
        expect(editor.current?.getValue()).toBe('draft');
        expect(changes.at(-1)).toMatchObject({ value: 'draft', fromValueProp: true });
    });

    // One editor serves every session: undo after a switch must not bring back
    // the draft it replaced, while a write inside one draft stays undoable.
    test('undo stops at a value from another draft and walks through one draft', async () => {
        await act(async () => editor.current?.insertText('first session'));
        await render('second session', 1, 1);
        await undoOnce();
        expect(editor.current?.getValue()).toBe('second session');

        await render('second session with a chip', 2, 1);
        await undoOnce();
        expect(editor.current?.getValue()).toBe('second session');
    });

    // The mobile composer unmounts when it collapses and reattaches the view it kept.
    test('a retained view reattached with another draft has nothing to undo', async () => {
        const viewStore = createComposerEditorViewStore();
        const renderKept = (value: string, valueRevision: number, historyRevision: number) => act(async () => root.render(
            <ComposerEditor ref={editor} value={value} valueRevision={valueRevision} historyRevision={historyRevision}
                viewStore={viewStore} languageContext={languageContext} onChange={() => {}} />,
        ));
        await act(async () => root.render(null));
        await renderKept('', 0, 0);
        await act(async () => editor.current?.insertText('draft A'));
        await act(async () => root.render(null));
        await renderKept('draft B', 1, 1);
        await undoOnce();
        expect(editor.current?.getValue()).toBe('draft B');
        await act(async () => root.render(null));
        viewStore.view?.destroy();
    });
});
