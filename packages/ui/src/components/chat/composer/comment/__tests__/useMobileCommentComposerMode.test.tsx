import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { toast } from '@/components/ui';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import type { MobileComposerShell } from '../../state/useMobileComposerShell';
import { MobileCommentComposerContext } from '../MobileCommentComposerContext';
import { createMobileCommentDraftController, type MobileCommentDraftController } from '../mobileCommentDraft';
import { useMobileCommentComposerMode, type MobileCommentMode } from '../useMobileCommentComposerMode';

describe('mobile comment composer integration', () => {
    let root: Root;
    let controller: MobileCommentDraftController;
    let mode: MobileCommentMode | null;
    let expansions: number;
    let render: (sessionKey: string, isMobile?: boolean) => Promise<void>;
    let restoreGlobals: () => void;

    const currentMode = () => {
        if (!mode) throw new Error('composer is not mounted');
        return mode;
    };

    beforeEach(() => {
        const dom = new Window();
        const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
        const descriptors = Object.getOwnPropertyDescriptors(globalThis);
        Object.assign(globalThis, globals);
        restoreGlobals = () => {
            for (const key of Object.keys(globals)) {
                const descriptor = descriptors[key];
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        };
        root = createRoot(document.createElement('div'));
        controller = createMobileCommentDraftController();
        mode = null;
        expansions = 0;
        const noop = () => {};
        const mobileShell: MobileComposerShell = {
            expanded: true, focused: false, overlayHostBusy: false, dictationActive: false,
            expand: () => { expansions += 1; },
            onDictationActiveChange: noop, onEditorFocus: noop, onEditorBlur: noop,
            skipNextOverlayCloseRestore: noop, cancelOverlayCloseRestore: noop,
        };
        const Composer = ({ sessionKey, isMobile }: { sessionKey: string; isMobile: boolean }) => {
            mode = useMobileCommentComposerMode({
                isMobile, runtimeKey: getRuntimeKey(), directory: '/repo', sessionKey, mobileShell,
            });
            return null;
        };
        render = async (sessionKey, isMobile = true) => {
            await act(async () => root.render(
                <I18nProvider>
                    <MobileCommentComposerContext.Provider value={controller}>
                        <Composer sessionKey={sessionKey} isMobile={isMobile} />
                    </MobileCommentComposerContext.Provider>
                </I18nProvider>,
            ));
        };
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
        toast.dismiss();
        restoreGlobals();
    });

    const open = async () => {
        await act(async () => {
            expect(controller.open({ plainText: 'selected text', markdownText: '**selected text**', messageId: 'msg_1' })).toBe(true);
        });
        expect(currentMode().active).toBe(true);
    };

    test('pending BTW stays open across rerenders and attaches to its published target', async () => {
        await render('btw-pending:parent');
        await open();
        await render('btw-pending:parent');
        expect(currentMode().active).toBe(true);
        await act(async () => currentMode().handlers.onTextChange('a comment'));
        await act(async () => currentMode().handlers.onAttach());
        expect(currentMode().active).toBe(false);
        expect(expansions).toBe(1);
        const store = useInlineCommentDraftStore.getState();
        expect(store.getDrafts({ directory: '/repo', sessionKey: 'btw-pending:parent' })[0]?.text).toBe('a comment');
        expect(store.getDrafts({ directory: '/repo', sessionKey: 'parent' })).toEqual([]);
    });

    test('switching from BTW to the parent rejects the old dictation callback', async () => {
        await render('btw-session');
        await open();
        const previousHandlers = currentMode().handlers;
        await render('parent');
        expect(currentMode().active).toBe(false);
        await open();
        await act(async () => previousHandlers.onDictationInsertAndSend('stale transcript'));
        expect(controller.getState()).toMatchObject({ status: 'open', text: '', scope: { sessionKey: 'parent' } });
        expect(useInlineCommentDraftStore.getState().drafts).toEqual({});
        expect(expansions).toBe(0);
    });

    test('failed attach keeps the editor open with an error, then retry restores the composer', async () => {
        await render('parent');
        await open();
        await act(async () => currentMode().handlers.onTextChange('x'.repeat(1_048_576)));
        await act(async () => currentMode().submit());
        expect(currentMode().active).toBe(true);
        expect(expansions).toBe(0);
        const errorToast = toast.getHistory().at(-1);
        if (!errorToast || !('title' in errorToast)) throw new Error('expected an error toast');
        expect(errorToast.type).toBe('error');
        expect(errorToast.title).toContain('Could not attach the comment');
        await act(async () => currentMode().handlers.onTextChange('short enough'));
        await act(async () => currentMode().submit());
        expect(currentMode().active).toBe(false);
        expect(expansions).toBe(1);
    });

    test('a desktop composer publishes no mobile comment target', async () => {
        await render('parent', false);
        expect(controller.open({ plainText: 'text', markdownText: 'text', messageId: null })).toBe(false);
    });

    test('runtime switching rejects a transcript before the composer has rerendered', async () => {
        await render('parent');
        await open();
        const previousRuntime = getRuntimeKey();
        const previousHandlers = currentMode().handlers;
        Object.defineProperty(window, '__OPENCHAMBER_API_BASE_URL__', { value: 'https://other.example.com' });
        expect(getRuntimeKey()).not.toBe(previousRuntime);
        await act(async () => previousHandlers.onDictationInsertAndSend('late transcript'));
        expect(currentMode().active).toBe(false);
        expect(useInlineCommentDraftStore.getState().drafts).toEqual({});
        expect(expansions).toBe(0);
    });
});
