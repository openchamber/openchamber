import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('toolbar menu state stays local while view actions remain direct children', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, DocumentFragment: dom.DocumentFragment,
        Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { DiffViewToolbar } = await import('./DiffViewToolbar');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let viewRenders = 0;
    const View = () => {
        viewRenders += 1;
        return (
            <DiffViewToolbar
                hasFiles
                isMobileLayout={false}
                diffFileListMode="flat"
                setDiffFileListMode={() => {}}
                diffWrapLines={false}
                diffWrapLinesStore={false}
                setDiffWrapLines={() => {}}
                diffHideWhitespace={false}
                setDiffHideWhitespace={() => {}}
                currentLayoutForAllFiles="inline"
                handleHeaderLayoutChange={() => {}}
                showWalkthroughButton
                openWalkthrough={() => {}}
            >
                <button type="button" data-view-action="">Review</button>
            </DiffViewToolbar>
        );
    };
    try {
        await act(async () => root.render(<I18nProvider><View /></I18nProvider>));
        const action = container.querySelector('[data-view-action]');
        const row = action?.parentElement;
        expect(row).not.toBeNull();
        expect(row?.firstElementChild).toBe(action);
        const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
        expect(trigger).not.toBeNull();
        // Fit communicates overflow through the row's attribute. Opening the
        // menu reads it without re-rendering the view that owns the actions.
        row?.setAttribute('data-diff-toolbar-more-walkthrough', '');
        const beforeOpen = viewRenders;
        await act(async () => trigger?.click());
        expect(document.querySelector('[role="menu"]')?.textContent).toContain('Walkthrough');
        expect(viewRenders).toBe(beforeOpen);
        expect(action?.parentElement).toBe(row);
    } finally {
        await act(async () => root.unmount());
        await dom.happyDOM.abort();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
}, 30_000);
