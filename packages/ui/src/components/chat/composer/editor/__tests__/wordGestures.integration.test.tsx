import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runScopeHandlers } from '@codemirror/view';
import { ComposerEditor, type ComposerEditorHandle } from '../ComposerEditor';
import { createComposerEditorViewStore } from '../viewStore';
import type { ComposerLanguageContext } from '../../language/tokenize';

// CodeMirror picks its platform at import time, before happy-dom is installed.
const mac = /Mac/.test(navigator.platform);
const wordModifier = mac ? { altKey: true } : { ctrlKey: true };
const undoModifier = mac ? { metaKey: true } : { ctrlKey: true };
const wordKey = mac ? 'Alt' : 'Ctrl';
const undoKey = mac ? 'Cmd' : 'Ctrl';

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
            <ComposerEditor ref={editor} scriptAwareWords viewStore={viewStore} value="" placeholder="Build or ask"
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
    type Modifiers = { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };

    const press = (key: string, options: Modifiers = {}) => {
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
    const pressKeymap = (key: string, options: Modifiers = {}) => {
        const event = new browser.KeyboardEvent('keydown', {
            key, code: key, bubbles: true, cancelable: true, ...options,
        });
        const view = viewStore.view;
        if (!view) throw new Error('Composer not mounted');
        return runScopeHandlers(view, asDomEvent(event), 'editor');
    };

    test(`${wordKey}+ArrowLeft steps one script run at a time`, async () => {
        await type('检查openchamber的配置');
        press('ArrowLeft', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 13, end: 13 });
        press('ArrowLeft', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 2, end: 2 });
        press('ArrowLeft', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 0 });
    });

    test(`${wordKey}+ArrowRight steps one script run at a time`, async () => {
        await type('检查openchamber的配置', 0);
        press('ArrowRight', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 2, end: 2 });
        press('ArrowRight', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 13, end: 13 });
        press('ArrowRight', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 16, end: 16 });
    });

    test(`${wordKey}+Shift+ArrowRight selects one script run per press`, async () => {
        await type('检查openchamber的配置', 0);
        expect(pressKeymap('ArrowRight', { ...wordModifier, shiftKey: true })).toBe(true);
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 2 });
        pressKeymap('ArrowRight', { ...wordModifier, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 13 });
        pressKeymap('ArrowRight', { ...wordModifier, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 16 });
    });

    test(`${wordKey}+Shift+ArrowLeft shrinks a forward selection one run at a time`, async () => {
        await type('检查openchamber的配置', 16);
        pressKeymap('ArrowLeft', { ...wordModifier, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 13, end: 16 });
        pressKeymap('ArrowLeft', { ...wordModifier, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 2, end: 16 });
    });

    test(`${wordKey}+Backspace deletes only the Chinese run before the caret`, async () => {
        await type('检查openchamber的配置');
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('检查openchamber');
        expect(editor.current?.getSelection()).toEqual({ start: 13, end: 13 });
    });

    test(`${wordKey}+Backspace stops where the script changes inside a word`, async () => {
        await type('检查openchamber');
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('检查');
    });

    test(`each ${wordKey}+Backspace removes one script run`, async () => {
        await type('检查openchamber的配置');
        press('Backspace', wordModifier);
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('检查');
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('');
    });

    test(`${wordKey}+Backspace removes an accented word in one press`, async () => {
        await type('café');
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('');
    });

    test(`${wordKey}+Delete deletes only the run after the caret`, async () => {
        await type('检查openchamber的配置', 0);
        press('Delete', wordModifier);
        expect(editor.current?.getValue()).toBe('openchamber的配置');
    });

    // Whitespace transitions match CodeMirror's stock group commands: a word
    // stops before the space after it, and a walk from a gap or a line break
    // crosses it and takes the next word.
    test(`${wordKey}+ArrowRight keeps CodeMirror's whitespace transitions`, async () => {
        await type('one two', 0);
        press('ArrowRight', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 3, end: 3 });
        press('ArrowRight', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 7, end: 7 });
    });

    test(`${wordKey}+Shift+ArrowRight selects a word, then crosses a gap to the next`, async () => {
        await type('one two', 0);
        pressKeymap('ArrowRight', { ...wordModifier, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 3 });
        await act(async () => editor.current?.setSelection(3));
        pressKeymap('ArrowRight', { ...wordModifier, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 3, end: 7 });
    });

    test(`${wordKey}+Shift+ArrowRight stops at a line break, then crosses it with the indentation`, async () => {
        await type('one\n  two', 0);
        pressKeymap('ArrowRight', { ...wordModifier, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 3 });
        await act(async () => editor.current?.setSelection(3));
        pressKeymap('ArrowRight', { ...wordModifier, shiftKey: true });
        expect(editor.current?.getSelection()).toEqual({ start: 3, end: 9 });
    });

    test(`${wordKey}+ArrowLeft crosses a gap back to the start of the previous word`, async () => {
        await type('one two', 4);
        press('ArrowLeft', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 0, end: 0 });
    });

    test(`${wordKey}+Backspace keeps a Japanese kana and kanji run whole`, async () => {
        await type('設定を確認');
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('');
    });

    test(`${wordKey}+Backspace and ${wordKey}+Delete split a digit run at the same place`, async () => {
        await type('API2中');
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('API2');
        await type('中', 0);
        expect(editor.current?.getValue()).toBe('API2中');
        press('Delete', wordModifier);
        expect(editor.current?.getValue()).toBe('中');
    });

    test(`${wordKey}+Arrow stops at the same place in a digit run both ways`, async () => {
        await type('API2中', 0);
        press('ArrowRight', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 4, end: 4 });
        await act(async () => editor.current?.setSelection(5));
        press('ArrowLeft', wordModifier);
        expect(editor.current?.getSelection()).toEqual({ start: 4, end: 4 });
    });

    // A macOS-only binding: elsewhere Ctrl+Alt+H stays unbound.
    test('Ctrl+Alt+H deletes one script run on macOS', async () => {
        await type('检查openchamber的配置');
        expect(pressKeymap('h', { ctrlKey: true, altKey: true })).toBe(mac);
        expect(editor.current?.getValue()).toBe(mac ? '检查openchamber' : '检查openchamber的配置');
    });

    test('plain Backspace still deletes one character', async () => {
        await type('检查');
        press('Backspace');
        expect(editor.current?.getValue()).toBe('检');
    });

    test(`${undoKey}+Z restores a ${wordKey}+Backspace deletion`, async () => {
        await type('检查openchamber的配置');
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('检查openchamber');
        press('z', undoModifier);
        expect(editor.current?.getValue()).toBe('检查openchamber的配置');
    });

    test(`one ${undoKey}+Z restores a run of adjacent ${wordKey}+Backspace deletions`, async () => {
        await type('检查openchamber的配置');
        press('Backspace', wordModifier);
        press('Backspace', wordModifier);
        expect(editor.current?.getValue()).toBe('检查');
        press('z', undoModifier);
        expect(editor.current?.getValue()).toBe('检查openchamber的配置');
    });
});
