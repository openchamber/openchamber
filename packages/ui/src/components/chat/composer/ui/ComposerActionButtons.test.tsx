import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { ComposerActionButtons } from './ComposerActionButtons';

describe('ComposerActionButtons action states', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        windowInstance = new Window();
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            HTMLElement: windowInstance.HTMLElement,
            Element: windowInstance.Element,
            Node: windowInstance.Node,
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    const renderButtons = (overrides: Partial<React.ComponentProps<typeof ComposerActionButtons>>) => {
        act(() => root.render(
            <I18nProvider>
                <ComposerActionButtons
                    isMobile={false}
                    footerIconButtonClass="button"
                    sendIconSizeClass="send-icon"
                    stopIconSizeClass="stop-icon"
                    canSend
                    canAbort
                    hasContent
                    isSubmitting={false}
                    currentSessionId="session-1"
                    newSessionDraftOpen={false}
                    onPrimaryAction={() => undefined}
                    onQueueMessage={() => undefined}
                    onAbort={() => undefined}
                    {...overrides}
                />
            </I18nProvider>,
        ));
    };

    afterEach(() => {
        act(() => root.unmount());
        windowInstance.close();
    });

    test('shows a busy spinner instead of send or stop while awaiting acknowledgement', () => {
        renderButtons({ isSubmitting: true });

        const button = host.querySelector('button');
        expect(button?.getAttribute('aria-busy')).toBe('true');
        expect(button?.querySelector('use')?.getAttribute('href')).toBe('#oc-loader-4');
    });

});
