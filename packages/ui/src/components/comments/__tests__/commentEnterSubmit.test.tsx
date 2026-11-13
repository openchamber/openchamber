import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ChatQuoteMarkPopover } from '@/components/chat/message/ChatQuoteMarkPopover';
import { CommentTextEditor } from '@/components/comments/CommentTextEditor';
import { useCommentImagePaste } from '@/components/comments/useCommentImagePaste';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { InlineCommentInput } from '../InlineCommentInput';

describe('comment fields and the return key', () => {
    let browser: Window;
    let root: Root;
    let restoreGlobals: () => void;
    let saved: number;

    const CommentEditorHost = ({ onSave }: { onSave: () => void }) => {
        const imagePaste = useCommentImagePaste();
        return (
            <CommentTextEditor
                value="note"
                onChange={() => undefined}
                onSubmit={onSave}
                onCancel={() => undefined}
                enterSubmits
                imagePaste={imagePaste}
                placeholder="Comment"
            />
        );
    };

    beforeEach(() => {
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
        saved = 0;
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        browser.close();
        restoreGlobals();
        useUIStore.getState().setMobileReturnKeySends(false);
        useUIStore.getState().setIsMobile(false);
    });

    const pressEnter = async (
        field: NonNullable<ReturnType<Window['document']['querySelector']>>,
        init: Pick<KeyboardEventInit, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'keyCode'> = {},
    ) => {
        const event = new browser.KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...init,
        });
        await act(async () => { field.dispatchEvent(event); });
        return event;
    };

    const surfaces = [
        {
            name: 'line comment',
            mount: async () => {
                await act(async () => root.render(
                    <I18nProvider>
                        <InlineCommentInput
                            initialText="note"
                            onSave={() => { saved += 1; }}
                            onCancel={() => undefined}
                        />
                    </I18nProvider>,
                ));
            },
            field: () => browser.document.querySelector('textarea'),
        },
        {
            name: 'quote comment',
            mount: async () => {
                const anchorRect = {
                    top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0,
                    toJSON: () => ({}),
                };
                await act(async () => root.render(
                    <I18nProvider>
                        <ChatQuoteMarkPopover
                            anchorRect={anchorRect}
                            comment="quoted"
                            editing
                            onEditingChange={() => undefined}
                            onSave={() => { saved += 1; }}
                            onRemove={() => undefined}
                        />
                    </I18nProvider>,
                ));
            },
            field: () => browser.document.querySelector('textarea'),
        },
        {
            name: 'pending comment',
            mount: async () => {
                await act(async () => root.render(
                    <I18nProvider>
                        <CommentEditorHost onSave={() => { saved += 1; }} />
                    </I18nProvider>,
                ));
            },
            field: () => browser.document.querySelector('.cm-content'),
        },
    ];

    for (const surface of surfaces) {
        test(`${surface.name}: desktop Enter submits`, async () => {
            await surface.mount();
            const field = surface.field();
            if (!field) throw new Error('comment field not mounted');
            await pressEnter(field);
            expect(saved).toBe(1);
        });

        test(`${surface.name}: mobile Enter follows the setting`, async () => {
            await act(async () => { useUIStore.getState().setIsMobile(true); });
            await surface.mount();
            await act(async () => { useUIStore.getState().setMobileReturnKeySends(true); });
            const field = surface.field();
            if (!field) throw new Error('comment field not mounted');
            await pressEnter(field);
            expect(saved).toBe(1);
            expect(field.getAttribute('enterkeyhint')).toBe('send');
        });

        test(`${surface.name}: mobile Enter breaks the line with the setting off`, async () => {
            await act(async () => { useUIStore.getState().setIsMobile(true); });
            await surface.mount();
            await act(async () => { useUIStore.getState().setMobileReturnKeySends(false); });
            const field = surface.field();
            if (!field) throw new Error('comment field not mounted');
            const event = await pressEnter(field);
            expect(saved).toBe(0);
            // Happy DOM does not apply native textarea editing defaults.
            if (field.tagName === 'TEXTAREA') expect(event.defaultPrevented).toBe(false);
            else expect(field.querySelectorAll('.cm-line')).toHaveLength(2);
            expect(field.getAttribute('enterkeyhint')).toBeNull();
        });

        for (const returnKeySends of [false, true]) {
            for (const [modifier, init, submits] of [
                ['Shift', { shiftKey: true }, false],
                ['Alt', { altKey: true }, false],
                ['Ctrl', { ctrlKey: true }, true],
                ['Cmd', { metaKey: true }, true],
                ['IME', { keyCode: 229 }, false],
            ] as const) {
                test(`${surface.name}: mobile ${modifier}+Enter with Return key sends ${returnKeySends}`, async () => {
                    useUIStore.getState().setIsMobile(true);
                    useUIStore.getState().setMobileReturnKeySends(returnKeySends);
                    await surface.mount();
                    const field = surface.field();
                    if (!field) throw new Error('comment field not mounted');
                    const event = await pressEnter(field, init);
                    expect(saved).toBe(submits ? 1 : 0);
                    if (submits || field.tagName === 'TEXTAREA') expect(event.defaultPrevented).toBe(submits);
                    if (!submits && modifier !== 'IME' && field.classList.contains('cm-content')) {
                        expect(field.querySelectorAll('.cm-line')).toHaveLength(2);
                    }
                });
            }
        }
    }
});
