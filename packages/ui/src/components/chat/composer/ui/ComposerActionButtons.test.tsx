import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { useMessageQueueStore, type FollowUpBehavior } from '@/stores/messageQueueStore';

import { ComposerActionButtons } from './ComposerActionButtons';

// Renders the controls (busy with content by default) and returns their buttons' classes.
const renderActionClasses = async (props: { canAbort: boolean; footerIconButtonClass: string }) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(
            <ThemeSystemProvider>
            <I18nProvider>
                <ComposerActionButtons
                    isMobile={false}
                    footerIconButtonClass={props.footerIconButtonClass}
                    sendIconSizeClass="send-icon-size"
                    stopIconSizeClass="stop-icon-size"
                    canSend
                    canAbort={props.canAbort}
                    hasContent
                    currentSessionId="session-1"
                    newSessionDraftOpen={false}
                    onPrimaryAction={() => {}}
                    onAbort={() => {}}
                />
            </I18nProvider>
            </ThemeSystemProvider>));
        return [...container.querySelectorAll('button')].map((button) => button.className.split(/\s+/));
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

// Renders the busy-session controls and clicks the action above Stop.
const clickFollowUpAction = async (followUpBehavior: FollowUpBehavior) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    useMessageQueueStore.setState({ followUpBehavior });
    const container = document.createElement('div');
    const root = createRoot(container);
    let primaryActions = 0;
    try {
        await act(async () => root.render(
            <ThemeSystemProvider>
            <I18nProvider>
                <ComposerActionButtons
                    isMobile={false}
                    footerIconButtonClass="icon-button"
                    sendIconSizeClass="send-icon-size"
                    stopIconSizeClass="stop-icon-size"
                    canSend
                    canAbort
                    hasContent
                    currentSessionId="session-1"
                    newSessionDraftOpen={false}
                    onPrimaryAction={() => { primaryActions += 1; }}
                    onAbort={() => {}}
                />
            </I18nProvider>
            </ThemeSystemProvider>));
        const action = container.querySelector<HTMLButtonElement>('button.bottom-full');
        const markup = action?.outerHTML ?? '';
        await act(async () => { action?.click(); });
        return { markup, primaryActions };
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

describe('ComposerActionButtons', () => {
    test('queues a follow-up through the send path when follow-ups queue', async () => {
        const { markup, primaryActions } = await clickFollowUpAction('queue');

        expect(markup).toContain('aria-label="Queue message"');
        expect(markup).toContain('-rotate-90');
        expect(primaryActions).toBe(1);
    });

    test('shows a plain send that steers when follow-ups steer', async () => {
        const { markup, primaryActions } = await clickFollowUpAction('steer');

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).not.toContain('-rotate-90');
        expect(primaryActions).toBe(1);
    });

    test("idle and busy action buttons share one slot: the footer's own button size", async () => {
        for (const footerIconButtonClass of ['h-6 w-6', 'h-5 w-5']) {
            const sizes = (classes: string[]) => classes.filter((name) => /^[hw]-/.test(name)).sort();
            const expected = sizes(footerIconButtonClass.split(' '));
            const [send] = await renderActionClasses({ canAbort: false, footerIconButtonClass });
            const busy = await renderActionClasses({ canAbort: true, footerIconButtonClass });
            expect(sizes(send ?? [])).toEqual(expected);
            expect(busy.length).toBe(2);
            for (const button of busy) expect(sizes(button)).toEqual(expected);
        }
    });
});
