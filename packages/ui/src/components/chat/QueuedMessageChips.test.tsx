import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { QueuedMessageChips } from './QueuedMessageChips';

describe('QueuedMessageChips sending state', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        windowInstance = new Window();
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            navigator: windowInstance.navigator,
            HTMLElement: windowInstance.HTMLElement,
            Element: windowInstance.Element,
            Node: windowInstance.Node,
            SVGElement: windowInstance.SVGElement,
            MutationObserver: windowInstance.MutationObserver,
            getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
        useSessionUIStore.setState({ currentSessionId: 'session-1', currentSessionDirectory: '/repo' });
    });

    afterEach(() => {
        act(() => root.unmount());
        windowInstance.close();
    });

    test('keeps an awaiting-ack item visible with disabled actions and a spinner', () => {
        const target = createMessageQueueTarget('session-1', '/repo')!;
        useMessageQueueStore.getState().addToQueue(target, { content: 'queued prompt' });
        const [message] = useMessageQueueStore.getState().getQueueForTarget(target);
        useMessageQueueStore.getState().claimForSend(target, [message.id]);

        act(() => root.render(
            <I18nProvider>
                <QueuedMessageChips onEditMessage={() => undefined} onSendMessage={() => undefined} />
            </I18nProvider>,
        ));

        expect(host.textContent).toContain('queued prompt');
        const sendingButton = host.querySelector('button[aria-busy="true"]');
        expect(sendingButton?.querySelector('use')?.getAttribute('href')).toBe('#oc-loader-4');
        expect([...host.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    });
});
