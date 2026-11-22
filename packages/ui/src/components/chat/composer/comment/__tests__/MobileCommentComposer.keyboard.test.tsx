import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useUIStore } from '@/stores/useUIStore';
import { MobileCommentComposer, type MobileCommentComposerHandlers } from '../MobileCommentComposer';
import type { MobileCommentDraft } from '../mobileCommentDraft';

const draft: Extract<MobileCommentDraft, { status: 'open' }> = {
    status: 'open',
    scope: { runtimeKey: 'test', directory: '/repo', sessionKey: 'session' },
    quote: { plainText: 'quoted', markdownText: 'quoted', messageId: null },
    text: '',
    generation: 1,
};

describe('mobile comment composer return key', () => {
    let browser: Window;
    let root: Root;
    let restoreGlobals: () => void;
    let attached: number;

    const handlers = (): MobileCommentComposerHandlers => {
        const noop = () => undefined;
        return {
            onTextChange: noop,
            onCancel: noop,
            onAttach: () => { attached += 1; },
            onDictationInsert: noop,
            onDictationInsertAndSend: noop,
            onEditorFocus: noop,
            onEditorBlur: noop,
            onDictationActiveChange: noop,
        };
    };

    const pressEnter = async (options: Pick<KeyboardEventInit, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'keyCode'> = {}) => {
        const content = browser.document.querySelector('.cm-content');
        if (!content) throw new Error('comment editor not mounted');
        const event = new browser.KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...options,
        });
        await act(async () => { content.dispatchEvent(event); });
        return event;
    };

    const lines = (): number => browser.document.querySelectorAll('.cm-content .cm-line').length;

    beforeEach(async () => {
        browser = new Window();
        const globals = {
            window: browser,
            document: browser.document,
            navigator: browser.navigator,
            HTMLElement: browser.HTMLElement,
            Element: browser.Element,
            Node: browser.Node,
            MutationObserver: browser.MutationObserver,
            ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser),
            localStorage: browser.localStorage,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const descriptors = Object.getOwnPropertyDescriptors(globalThis);
        Object.assign(globalThis, globals);
        restoreGlobals = () => {
            for (const key of Object.keys(globals)) {
                const descriptor = descriptors[key];
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        };
        attached = 0;
        useUIStore.getState().setIsMobile(true);
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => root.render(
            <I18nProvider>
                <ThemeSystemProvider>
                    <MobileCommentComposer
                        draft={draft}
                        theme={getDefaultTheme(true)}
                        handlers={handlers()}
                    />
                </ThemeSystemProvider>
            </I18nProvider>,
        ));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        browser.close();
        restoreGlobals();
        useUIStore.getState().setMobileReturnKeySends(false);
        useUIStore.getState().setIsMobile(false);
    });

    test('with the setting on, Enter attaches the comment', async () => {
        await act(async () => useUIStore.getState().setMobileReturnKeySends(true));
        const event = await pressEnter();
        expect(event.defaultPrevented).toBe(true);
        expect(attached).toBe(1);
        expect(lines()).toBe(1);
        expect(browser.document.querySelector('.cm-content')?.getAttribute('enterkeyhint')).toBe('send');
    });

    test('with the setting on, Shift+Enter leaves the newline to the editor', async () => {
        await act(async () => useUIStore.getState().setMobileReturnKeySends(true));
        await pressEnter({ shiftKey: true });
        expect(attached).toBe(0);
        expect(lines()).toBe(2);
    });

    test('with the setting off, Enter inserts a newline instead of attaching', async () => {
        await act(async () => useUIStore.getState().setMobileReturnKeySends(false));
        await pressEnter();
        expect(attached).toBe(0);
        expect(lines()).toBe(2);
        expect(browser.document.querySelector('.cm-content')?.getAttribute('enterkeyhint')).toBeNull();
    });

    test('Ctrl+Enter attaches regardless of the setting', async () => {
        await act(async () => useUIStore.getState().setMobileReturnKeySends(false));
        const event = await pressEnter({ ctrlKey: true });
        expect(event.defaultPrevented).toBe(true);
        expect(attached).toBe(1);
        expect(lines()).toBe(1);
    });

    test('an IME composition Enter does not attach', async () => {
        await act(async () => useUIStore.getState().setMobileReturnKeySends(true));
        await pressEnter({ keyCode: 229 });
        expect(attached).toBe(0);
    });

    test('Alt+Enter inserts a newline in Send mode', async () => {
        await act(async () => useUIStore.getState().setMobileReturnKeySends(true));
        await pressEnter({ altKey: true });
        expect(attached).toBe(0);
        expect(lines()).toBe(2);
    });

    test('Cmd+Enter attaches once with the setting off', async () => {
        await pressEnter({ metaKey: true });
        expect(attached).toBe(1);
        expect(lines()).toBe(1);
    });

    for (const returnKeySends of [false, true]) {
        test(`the attach button works with Return key sends ${returnKeySends}`, async () => {
            await act(async () => useUIStore.getState().setMobileReturnKeySends(returnKeySends));
            const button = browser.document.querySelector('button[aria-label="Attach"]');
            if (!button) throw new Error('attach button not mounted');
            await act(async () => button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
            expect(attached).toBe(1);
        });
    }
});
