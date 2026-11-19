import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { ComposerEditorView } from '../ComposerEditorView';
import { ComposerEditor } from '../ComposerEditor';

describe('ComposerEditorView', () => {
    test('isolates the composer EditContext opt-out', async () => {
        expect(ComposerEditorView.EDIT_CONTEXT).toBe(false);
        expect(Object.getOwnPropertyDescriptor(EditorView, 'EDIT_CONTEXT')?.value).not.toBe(false);

        const browser = new Window();
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        };
        const descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        try {
            await act(async () => root.render(React.createElement(ComposerEditor, {
                value: '', onChange: () => {}, languageContext: {
                    inputMode: 'normal', knownAgentNames: new Set<string>(), confirmedMentions: new Set<string>(),
                    knownSlashNames: new Set<string>(), knownSnippetTriggers: new Set<string>(), attachmentFilenames: [],
                },
            })));
            const content = host.querySelector<HTMLElement>('.cm-content');
            expect(content).not.toBeNull();
            expect(EditorView.findFromDOM(content!)).toBeInstanceOf(ComposerEditorView);
        } finally {
            await act(async () => root.unmount());
            browser.close();
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        }
    });
});
