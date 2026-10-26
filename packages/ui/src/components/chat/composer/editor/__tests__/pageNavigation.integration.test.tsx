import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerEditor, type ComposerEditorHandle } from '../ComposerEditor';
import type { ComposerLanguageContext } from '../../language/tokenize';

const languageContext: ComposerLanguageContext = {
    inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(),
    knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [],
};

describe('composer page navigation at document boundaries', () => {
    let browser: Window;
    let root: Root;
    let descriptors: Map<string, PropertyDescriptor | undefined>;
    const editor = React.createRef<ComposerEditorHandle>();

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
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => root.render(
            <ComposerEditor ref={editor} value="" placeholder="Build or ask"
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

    for (const value of ['', 'text']) {
        for (const key of ['PageUp', 'PageDown']) {
            for (const shiftKey of [false, true]) {
                test(`${shiftKey ? 'Shift+' : ''}${key} prevents native scrolling at the ${value ? 'text' : 'empty'} boundary`, async () => {
                    const position = key === 'PageUp' ? 0 : value.length;
                    await act(async () => {
                        if (value) editor.current?.insertText(value);
                        editor.current?.setSelection(position);
                    });
                    const content = browser.document.querySelector('.cm-content');
                    if (!content) throw new Error('Composer not mounted');
                    const event = new browser.KeyboardEvent('keydown', {
                        key, code: key, shiftKey, bubbles: true, cancelable: true,
                    });
                    await act(async () => { content.dispatchEvent(event); });
                    expect(event.defaultPrevented).toBe(true);
                    expect(editor.current?.getValue()).toBe(value);
                    expect(editor.current?.getSelection()).toEqual({ start: position, end: position });
                });
            }
        }
    }
});
