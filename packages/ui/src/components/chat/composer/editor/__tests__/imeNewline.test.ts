import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { standardKeymap } from '@codemirror/commands';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerEditor } from '../ComposerEditor';
import { imeNewlineCleanup } from '../imeNewline';

describe('IME newline cleanup extension', () => {
    let browser: Window;
    let view: EditorView;
    let descriptors: Map<string, PropertyDescriptor | undefined>;
    let now: ReturnType<typeof spyOn<DateConstructor, 'now'>>;
    let root: Root | null;

    beforeEach(() => {
        browser = new Window();
        root = null;
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
            InputEvent: browser.InputEvent, KeyboardEvent: browser.KeyboardEvent,
            MutationObserver: browser.MutationObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser),
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
        now = spyOn(Date, 'now');
        now.mockReturnValue(1000);
        view = new EditorView({
            state: EditorState.create({
                doc: 'a', selection: { anchor: 1 },
                extensions: [imeNewlineCleanup(), keymap.of(standardKeymap)],
            }),
            parent: document.body,
        });
    });

    afterEach(async () => {
        if (root) await act(async () => root!.unmount());
        else view.destroy();
        now.mockRestore();
        browser.close();
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    function beforeInput(inputType: string, data: string | null = null) {
        view.contentDOM.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true }));
    }

    // Feed CodeMirror's DOM-read extension point, then apply its normal transaction.
    function domRead(from: number, to: number, text: string) {
        const transaction = () => view.state.update({
            changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type',
        });
        const handled = view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, transaction));
        if (!handled) view.dispatch(transaction());
        return handled;
    }

    function newline(paddingInDocument = false) {
        beforeInput(paddingInDocument ? 'insertText' : 'insertParagraph', paddingInDocument ? '\n ' : null);
        domRead(1, 1, paddingInDocument ? '\n ' : '\n');
    }

    function domPadding() {
        beforeInput('insertText', ' ');
        const line = view.contentDOM.lastElementChild!;
        const text = document.createTextNode(' ');
        line.replaceChildren(text);
        document.getSelection()!.collapse(text, 1);
        view.contentDOM.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ' ', bubbles: true }));
        // CodeMirror can restore the DOM before replaying the deferred Backspace.
        line.replaceChildren(document.createElement('br'));
    }

    function key(key: string) {
        return runScopeHandlers(view, new KeyboardEvent('keydown', { key, keyCode: key === 'Backspace' ? 8 : 13 }), 'editor');
    }

    test('keeps the committed newline through the keymap cleanup, then allows ordinary Backspace', () => {
        newline();
        domPadding();
        key('Backspace');
        expect(view.state.doc.toString()).toBe('a\n');
        key('Backspace');
        expect(view.state.doc.toString()).toBe('a');
    });

    test('keeps the committed newline through the DOM-read cleanup', () => {
        newline();
        domPadding();
        beforeInput('deleteContentBackward');
        expect(domRead(1, 2, '')).toBe(true);
        expect(view.state.doc.toString()).toBe('a\n');
    });

    test('lets normal Backspace remove padding already in the document', () => {
        newline(true);
        key('Backspace');
        expect(view.state.doc.toString()).toBe('a\n');
    });

    test('does not swallow Backspace without confirmed DOM padding', () => {
        newline();
        key('Backspace');
        expect(view.state.doc.toString()).toBe('a');
    });

    test('does not swallow a DOM deletion without confirmed padding', () => {
        newline();
        expect(domRead(1, 2, '')).toBe(false);
        expect(view.state.doc.toString()).toBe('a');
    });

    for (const [anchor, head] of [[0, 2], [2, 0]]) {
        test(`deletes the whole selection from ${anchor} to ${head}`, () => {
            newline();
            domPadding();
            view.dispatch({ selection: { anchor, head } });
            key('Backspace');
            expect(view.state.doc.toString()).toBe('');
        });
    }

    test('clears on caret movement, even when the caret returns to the same newline', () => {
        newline();
        domPadding();
        view.dispatch({ selection: { anchor: 0 } });
        view.dispatch({ selection: { anchor: 2 } });
        key('Backspace');
        expect(view.state.doc.toString()).toBe('a');
    });

    test('clears on document replacement at the same caret position', () => {
        newline();
        domPadding();
        view.dispatch({ changes: { from: 0, to: 2, insert: 'b\n' }, selection: { anchor: 2 } });
        expect(domRead(1, 2, '')).toBe(false);
        expect(view.state.doc.toString()).toBe('b');
    });

    test('expires after 400 ms', () => {
        newline();
        domPadding();
        now.mockReturnValue(1401);
        key('Backspace');
        expect(view.state.doc.toString()).toBe('a');
    });

    test('Enter clears the cleanup before the composer handles it', () => {
        newline();
        domPadding();
        key('Enter');
        expect(domRead(1, 2, '')).toBe(false);
    });

    test('unrelated input clears the cleanup', () => {
        newline();
        domPadding();
        beforeInput('insertText', 'b');
        key('Backspace');
        expect(view.state.doc.toString()).toBe('a');
    });

    const languageContext = {
        inputMode: 'normal' as const, knownAgentNames: new Set<string>(), confirmedMentions: new Set<string>(),
        knownSlashNames: new Set<string>(), knownSnippetTriggers: new Set<string>(), attachmentFilenames: [],
    };

    async function mountComposer(ios: boolean, send: boolean) {
        view.destroy();
        Object.defineProperties(browser.navigator, {
            vendor: { configurable: true, value: ios ? 'Apple Computer, Inc.' : 'Google Inc.' },
            userAgent: { configurable: true, value: ios ? 'iPhone Mobile/15E148 Safari/604.1' : 'Chrome/130.0' },
            maxTouchPoints: { configurable: true, value: ios ? 5 : 0 },
        });
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await renderComposer(send);
        view = EditorView.findFromDOM(host.querySelector('.cm-content')!)!;
        view.dispatch({ selection: { anchor: 1 } });
    }

    async function renderComposer(send: boolean) {
        await act(async () => root!.render(React.createElement(ComposerEditor, {
            value: 'a', languageContext, returnKeySends: send, onChange: () => {},
        })));
    }

    for (const [ios, send] of [[true, true], [true, false], [false, true]] as const) {
        test(`composer gates cleanup on iOS=${ios}, Send=${send}`, async () => {
            await mountComposer(ios, send);
            newline();
            domPadding();
            key('Backspace');
            expect(view.state.doc.toString()).toBe(ios && send ? 'a\n' : 'a');
        });
    }

    test('switching to Return removes an armed cleanup', async () => {
        await mountComposer(true, true);
        newline();
        domPadding();
        await renderComposer(false);
        key('Backspace');
        expect(view.state.doc.toString()).toBe('a');
    });
});
