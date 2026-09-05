import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { SyncProvider } from '@/sync/sync-context';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { getDefaultTheme } from '@/lib/theme/themes';

import { MobilePillComposer } from './MobilePillComposer';

const renderPill = async (options: { hasContent: boolean; newSessionDraftOpen: boolean; canAbort?: boolean }) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    let primaryActions = 0;
    let queued = 0;
    try {
        await act(async () => root.render(
        <SyncProvider directory="/fixture" sdk={createOpencodeClient({ baseUrl: "http://opencode.test", fetch: async () => new Response("[]", { headers: { "content-type": "application/json" } }) })}>
        <ThemeSystemProvider>
        <I18nProvider>
            <MobilePillComposer
                directory="/fixture"
                message={options.hasContent ? 'Draft message' : ''}
                sessionId={options.newSessionDraftOpen ? null : 'session-1'}
                newSessionDraftOpen={options.newSessionDraftOpen}
                hasContent={options.hasContent}
                isVSCode={false}
                canAbort={options.canAbort ?? false}
                footerIconButtonClass="icon-button"
                iconSizeClass="icon-size"
                sendIconSizeClass="send-icon-size"
                stopIconSizeClass="stop-icon-size"
                theme={getDefaultTheme(false)}
                onExpand={() => {}}
                onApplySuggestion={() => {}}
                onPrimaryAction={() => { primaryActions += 1; }}
                onQueueMessage={() => { queued += 1; }}
                onNewSession={() => {}}
                onPickLocalFiles={() => {}}
                onOpenIssuePicker={() => {}}
                onOpenPrPicker={() => {}}
                onOpenAttachSheet={() => {}}
                onStartDictation={() => {}}
                onAbort={() => {}}
            />
        </I18nProvider>
        </ThemeSystemProvider>
        </SyncProvider>));
        if (options.hasContent && options.canAbort) {
            // While a turn runs the draft can only be queued, never sent past it.
            const queue = container.querySelector<HTMLButtonElement>('[aria-label="Queue message"]');
            expect(queue).not.toBeNull();
            await act(async () => { queue?.click(); });
            expect(queued).toBe(1);
            expect(primaryActions).toBe(0);
        } else if (options.hasContent) {
            const send = container.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
            expect(send).not.toBeNull();
            await act(async () => { send?.click(); });
            expect(primaryActions).toBe(1);
            expect(queued).toBe(0);
        }
        return container.innerHTML;
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

describe('MobilePillComposer', () => {
    test('uses the inline action to send content while the session is idle', async () => {
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: false });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).toContain('aria-label="New chat"');
        expect(markup.indexOf('aria-label="Send message"')).toBeLessThan(markup.indexOf('aria-label="New chat"'));
    });

    test('uses the trailing action to queue content while the session is running', async () => {
        // The expanded composer shows a rotated send icon labelled "Queue
        // message" in this state; the collapsed pill must read the same.
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: false, canAbort: true });

        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).toContain('aria-label="Queue message"');
        expect(markup).toContain('-rotate-90');
        expect(markup).not.toContain('aria-label="Send message"');
        expect(markup).not.toContain('aria-label="New chat"');
        expect(markup.indexOf('aria-label="Stop generating"')).toBeLessThan(markup.indexOf('aria-label="Queue message"'));
    });

    test('uses the inline send action for content in a new-session draft', async () => {
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: true });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).toContain('w-0 opacity-0 overflow-hidden');
    });

    test('keeps the new-session action for an empty existing session', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: false });

        expect(markup).toContain('aria-label="New chat"');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('keeps the trailing action collapsed for an empty new-session draft', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: true });

        expect(markup).toContain('w-0 opacity-0 overflow-hidden');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('keeps abort and new-session actions while a session runs without content', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: false, canAbort: true });

        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).toContain('aria-label="New chat"');
        expect(markup).not.toContain('aria-label="Send message"');
    });
});
