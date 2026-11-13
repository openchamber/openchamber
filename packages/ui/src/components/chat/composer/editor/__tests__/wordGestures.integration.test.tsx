import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runScopeHandlers } from '@codemirror/view';
import { ComposerEditor, type ComposerEditorHandle } from '../ComposerEditor';
import { createComposerEditorViewStore } from '../viewStore';
import type { ComposerLanguageContext } from '../../language/tokenize';

const languageContext: ComposerLanguageContext = {
    inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(),
    knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [],
};

/**
 * happy-dom builds its own KeyboardEvent class, while CodeMirror's
 * `runScopeHandlers` is typed against the DOM one. The fields it reads are the
 * same on both.
 */
function asDomEvent<T>(event: T): KeyboardEvent {
    // SAFETY: runScopeHandlers reads key, keyCode, the modifier flags and
    // preventDefault, all present on happy-dom's KeyboardEvent.
    return event as KeyboardEvent;
}

describe('composer word gestures at script boundaries', () => {
    let browser: Window;
    let root: Root;
    let descriptors: Map<string, PropertyDescriptor | undefined>;
    let viewStore: ReturnType<typeof createComposerEditorViewStore>;
    const editor = React.createRef<ComposerEditorHandle>();

    beforeEach(async () => {
        browser = new Window();
        viewStore = createComposerEditorViewStore();
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            // CodeMirror's measurement code checks `elt instanceof Window`.
            Window,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        };
        descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => root.render(
            <ComposerEditor ref={editor} viewStore={viewStore} value="" placeholder="Build or ask"
                languageContext={languageContext} onChange={() => {}} />,
        ));
        await act(async () => editor.current?.focus());
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        browser.close();
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    const type = async (value: string, caret = value.length) => {
        await act(async () => {
            editor.current?.insertText(value);
            editor.current?.setSelection(caret);
        });
    };

    // Dispatched synchronously, like a real key. Wrapped in `act` or followed
    // by an `await`, CodeMirror's deferred key path drops modified arrows.
    const press = (key: string, options: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => {
        const content = browser.document.querySelector('.cm-content');
        if (!content) throw new Error('Composer not mounted');
        const event = new browser.KeyboardEvent('keydown', {
            key, code: key, bubbles: true, cancelable: true, ...options,
        });
        content.dispatchEvent(event);
        return event;
    };

    // Runs the keymap directly. A second DOM keydown while a selection is
    // non-empty makes CodeMirror re-read happy-dom's selection, which stays
    // collapsed at 0, so the press would start from the wrong end. The binding
    // reached here is the one a real key reaches.
    const pressKeymap = (key: string, options: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => {
        const event = new browser.KeyboardEvent('keydown', {
            key, code: key, bubbles: true, cancelable: true, ...options,
        });
        return runScopeHandlers(viewStore.view!, asDomEvent(event), 'editor');
    };

    test('Ctrl+ArrowLeft steps one script run at a time', async () => {
        await type('检查openchamber的配置');
        press('ArrowLeft', { ctrlKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 13, end: 13 });
        press('ArrowLeft', { ctrlKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 2, end: 2 });
        press('ArrowLeft', { ctrlKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 0 });
    });

    test('Ctrl+ArrowRight steps one script run at a time', async () => {
        await type('检查openchamber的配置', 0);
        press('ArrowRight', { ctrlKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 2, end: 2 });
        press('ArrowRight', { ctrlKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 13, end: 13 });
        press('ArrowRight', { ctrlKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 16, end: 16 });
    });

    test('Ctrl+Shift+ArrowRight selects one script run per press', async () => {
        await type('检查openchamber的配置', 0);
        expect(pressKeymap('ArrowRight', { ctrlKey: true, shiftKey: true })).toBe(true);
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 2 });
        pressKeymap('ArrowRight', { ctrlKey: true, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 13 });
        pressKeymap('ArrowRight', { ctrlKey: true, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 16 });
    });

    test('Ctrl+Shift+ArrowLeft shrinks a forward selection one run at a time', async () => {
        await type('检查openchamber的配置', 16);
        pressKeymap('ArrowLeft', { ctrlKey: true, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 13, end: 16 });
        pressKeymap('ArrowLeft', { ctrlKey: true, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 2, end: 16 });
    });

    test('Ctrl+Backspace deletes only the Chinese run before the caret', async () => {
        await type('检查openchamber的配置');
        press('Backspace', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('检查openchamber');
        expect(editor.current?.getSelection()).toEqual({ start: 13, end: 13 });
    });

    test('Ctrl+Backspace stops where the script changes inside a word', async () => {
        await type('检查openchamber');
        press('Backspace', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('检查');
    });

    test('each Ctrl+Backspace removes one script run', async () => {
        await type('检查openchamber的配置');
        press('Backspace', { ctrlKey: true });
        press('Backspace', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('检查');
        press('Backspace', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('');
    });

    test('Ctrl+Backspace removes an accented word in one press', async () => {
        await type('café');
        press('Backspace', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('');
    });

    test('Ctrl+Delete deletes only the run after the caret', async () => {
        await type('检查openchamber的配置', 0);
        press('Delete', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('openchamber的配置');
    });

    test('plain Backspace still deletes one character', async () => {
        await type('检查');
        press('Backspace');
        expect(editor.current?.getValue()).toBe('检');
    });

    test('Ctrl+Z restores a Ctrl+Backspace deletion', async () => {
        await type('检查openchamber的配置');
        press('Backspace', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('检查openchamber');
        press('z', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('检查openchamber的配置');
    });

    test('one Ctrl+Z restores a run of adjacent Ctrl+Backspace deletions', async () => {
        await type('检查openchamber的配置');
        press('Backspace', { ctrlKey: true });
        press('Backspace', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('检查');
        press('z', { ctrlKey: true });
        expect(editor.current?.getValue()).toBe('检查openchamber的配置');
    });
});
