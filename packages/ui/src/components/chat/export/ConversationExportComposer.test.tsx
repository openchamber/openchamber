import { afterAll, afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import { createConversationSelectionStore } from './selectionStore';

const browser = new Window();
Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
});
const { ConversationExportComposer } = await import('./ConversationExportComposer');
const { ConversationSelectionContext } = await import('./selectionContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
const unavailable = (): never => { throw new Error('Rendering selection must not call runtime APIs'); };
const apis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
afterAll(() => browser.close());

const verifyComposerSelection = async (surface: 'desktop' | 'mobile') => {
    browser.location.href = `http://localhost/?surface=${surface}`;
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const composer = <form><textarea defaultValue="Draft and attachments stay here" /></form>;
    const store = createConversationSelectionStore();
    await act(async () => root?.render(
        <I18nProvider>
            <RuntimeAPIContext.Provider value={apis}>
                <ConversationSelectionContext.Provider value={store}>
                    <ConversationExportComposer getMessages={() => []} columnRef={{ current: container }}>{composer}</ConversationExportComposer>
                </ConversationSelectionContext.Provider>
            </RuntimeAPIContext.Provider>
        </I18nProvider>,
    ));
    const editor = container.querySelector('textarea');
    const editorSlot = container.querySelector<HTMLElement>('[data-conversation-export-composer]');
    expect(editorSlot?.style.visibility).toBe('');
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
    await act(async () => store.getState().begin('assistant:one'));
    expect(container.querySelector('textarea')).toBe(editor);
    expect(editorSlot?.style.visibility).toBe('hidden');
    expect(editorSlot?.hasAttribute('inert')).toBe(true);
    const toolbar = document.querySelector('[role="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.closest('[inert]')).toBeNull();
    expect(container.contains(toolbar)).toBe(surface === 'desktop');
    expect(toolbar?.closest('[data-conversation-export-toolbar]')?.querySelector('.oc-surface-floating')).not.toBeNull();
    expect(toolbar?.closest('[data-conversation-export-toolbar]')?.querySelector('.oc-glass-popover')).toBeNull();
    if (surface === 'mobile') {
        expect(toolbar?.closest('[data-conversation-export-toolbar]')?.classList.contains('bg-background')).toBe(true);
    }
    await act(async () => store.getState().toggle('assistant:one'));
    expect(toolbar?.querySelector('[role="status"]')?.textContent).toContain('0');
    const buttons = toolbar?.querySelectorAll('button');
    expect(buttons?.[1]?.disabled).toBe(true);
    expect(buttons?.[2]?.disabled).toBe(true);
    await act(async () => store.getState().cancel());
    expect(container.querySelector('textarea')).toBe(editor);
    expect(editor?.value).toBe('Draft and attachments stay here');
    expect(editorSlot?.style.visibility).toBe('');
    expect(editorSlot?.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    await act(async () => store.getState().begin('assistant:one'));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('textarea')).toBe(editor);
    expect(editorSlot?.style.visibility).toBe('');
};

for (const surface of ['desktop', 'mobile'] as const) {
    test(`${surface} selection preserves the editor and disables hidden controls`, () => verifyComposerSelection(surface));
}
