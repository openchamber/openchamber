import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { ComposerEditor, type ComposerChange } from '../ComposerEditor';

describe('composer value writeback composition guard (issue #2527)', () => {
    test('checks equality, then composition, before dispatching', async () => {
        const browser = new Window();
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            CompositionEvent: browser.CompositionEvent,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        };
        const descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        const changes: ComposerChange[] = [];
        const languageContext = {
            inputMode: 'normal' as const, knownAgentNames: new Set<string>(), confirmedMentions: new Set<string>(),
            knownSlashNames: new Set<string>(), knownSnippetTriggers: new Set<string>(), attachmentFilenames: [],
        };
        const render = (value: string, valueRevision: number) => act(async () => root.render(
            React.createElement(ComposerEditor, { value, valueRevision, languageContext, onChange: (change) => { changes.push(change); } }),
        ));
        try {
            await render('draft', 0);
            await render('draft', 1);
            expect(changes).toEqual([]);
            const content = host.querySelector<HTMLElement>('.cm-content');
            if (!content) throw new Error('Composer not mounted');
            const view = EditorView.findFromDOM(content);
            if (!view) throw new Error('Composer view not found');
            await act(async () => content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
            expect(view.compositionStarted).toBe(true);
            await render('stale echo', 2);
            expect(view.state.doc.toString()).toBe('draft');
            expect(changes).toEqual([]);
            await act(async () => content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
            await render('replacement', 3);
            expect(view.state.doc.toString()).toBe('replacement');
            expect(changes.at(-1)).toMatchObject({ value: 'replacement', fromValueProp: true });
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
