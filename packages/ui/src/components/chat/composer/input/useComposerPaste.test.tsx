import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createComposerText } from '../../composer/state/composerText';
import { PastedSessionIds } from '../../composer/pastedSessionIds';
import type { ComposerEditorHandle, ComposerSelection } from '../editor/ComposerEditor';
import { useComposerLargePasteState } from './useComposerLargePasteState';
import { useComposerPaste } from './useComposerPaste';

describe('useComposerPaste large-text choice', () => {
    let browser: Window;
    let root: Root;
    let host: HTMLDivElement;
    let saved: Map<string, PropertyDescriptor | undefined>;
    let offer: { resolve: (action: 'attach' | 'inline', explicit: boolean, typedText?: string) => void } | null;
    let value: string;
    let selection: ComposerSelection;
    let focused: boolean;
    let attachedFiles: File[];
    let attachmentResult: Promise<boolean>;
    let handlePaste: ((event: ClipboardEvent) => Promise<void>) | undefined;
    const editorRef = React.createRef<ComposerEditorHandle>();
    const pastedText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');

    beforeEach(() => {
        browser = new Window({ url: 'http://localhost' });
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            Event: browser.Event, CustomEvent: browser.CustomEvent, HTMLElement: browser.HTMLElement,
            Element: browser.Element, Node: browser.Node, MutationObserver: browser.MutationObserver,
            ResizeObserver: browser.ResizeObserver, KeyboardEvent: browser.KeyboardEvent,
            ClipboardEvent: browser.ClipboardEvent, DataTransfer: browser.DataTransfer,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        for (const [key, entry] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value: entry, configurable: true, writable: true });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        value = 'prefix suffix';
        selection = { start: 6, end: 6 };
        focused = false;
        attachedFiles = [];
        attachmentResult = Promise.resolve(true);
        offer = null;

        const editor: ComposerEditorHandle = {
            // Chromium can restore the pre-paste DOM caret when the choice releases focus.
            focus() { focused = true; selection = { start: 0, end: 0 }; },
            blur() { focused = false; },
            isFocused: () => focused,
            getValue: () => value,
            getSelection: () => selection,
            setSelection(start, end = start) { selection = { start, end }; },
            selectAll() { selection = { start: 0, end: value.length }; },
            insertText(text) {
                value = value.slice(0, selection.start) + text + value.slice(selection.end);
                selection = { start: selection.start + text.length, end: selection.start + text.length };
            },
            replaceRange(from, to, text) {
                value = value.slice(0, from) + text + value.slice(to);
                selection = { start: from + text.length, end: from + text.length };
            },
            caretCoords: () => null,
            getScrollDOM: () => null,
        };
        editorRef.current = editor;
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        browser.close();
        editorRef.current = null;
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    });

    function Harness() {
        const text = React.useMemo(() => createComposerText(value), []);
        const state = useComposerLargePasteState();
        const [pastedSessionIds] = React.useState(() => new PastedSessionIds());
        offer = state.largeTextPasteOffer;
        const paste = useComposerPaste({
            sessionScope: {
                inputMode: 'normal', isBtwActive: false, currentSessionId: 'test-session',
                newSessionDraftOpen: false,
                addAttachedFile: async (file) => {
                    attachedFiles.push(file);
                    return attachmentResult;
                },
            },
            language: {
                sessionLinkOrigins: [], resolveSessionLinks: async () => {}, readPastedReferenceLinks: async () => {},
                pastedSessionIds,
            },
            editorState: { composerRef: editorRef },
            draftText: { composerText: text, setMessage(next) { text.set(next); value = next; } },
            largePasteState: state,
            attachmentWork: { pendingPastedAttachmentFilenamesRef: { current: new Set<string>() } },
            i18n: { t: (key: string) => key },
            referenceDrafts: { receivedPageBases: [] },
            editorActions: {
                updateAutocompleteState() {}, markFileMentionPasteSuppression() {},
                insertTextAtSelection(inserted: string) { editorRef.current?.insertText(inserted); },
            },
            preferences: { largeTextPasteBehavior: 'ask' },
            largePasteScope: { readLargeTextPasteSnapshot: () => null },
            fileIntake: { attachFilesWithCitation: async () => {} },
            mobileShell: { mobileShell: {
                expanded: false, focused: false, overlayHostBusy: false, dictationActive: false,
                expand() {}, onDictationActiveChange() {}, holdDictationSend() {}, onEditorFocus() {}, onEditorBlur() {},
                skipNextOverlayCloseRestore() {}, cancelOverlayCloseRestore() {},
            } },
        });
        handlePaste = paste.handlePaste;
        return null;
    }

    async function raisePaste() {
        const transfer = new DataTransfer();
        transfer.setData('text/plain', pastedText);
        const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
        await act(async () => { await handlePaste?.(event); });
        expect(event.defaultPrevented).toBe(true);
        expect(offer).not.toBeNull();
    }

    async function render() {
        await act(async () => root.render(<Harness />));
    }

    test('accepted inline choice preserves caret after paste and type-through insertion', async () => {
        await render();
        await raisePaste();
        await act(async () => offer?.resolve('inline', true, '§'));
        const caret = 6 + pastedText.length + 1;
        expect(value).toBe(`prefix${pastedText}§ suffix`);
        expect(selection).toEqual({ start: caret, end: caret });
        expect(focused).toBe(true);
        editorRef.current?.insertText('!');
        expect(value).toBe(`prefix${pastedText}§! suffix`);
    });

    test('attach at the end keeps subsequent typing after the generated file reference', async () => {
        selection = { start: value.length, end: value.length };
        await render();
        await raisePaste();
        await act(async () => offer?.resolve('attach', true));
        const expected = 'prefix suffix [pasted-context-1.txt]';
        expect(value).toBe(expected);
        expect(selection).toEqual({ start: expected.length, end: expected.length });
        expect(attachedFiles.map((file) => file.name)).toEqual(['pasted-context-1.txt']);
        expect(await attachedFiles[0]?.text()).toBe(pastedText);
        editorRef.current?.insertText('§');
        expect(value).toBe(`${expected}§`);
    });

    test('attach replaces a selected range and preserves the suffix and insertion caret', async () => {
        value = 'before SELECT after';
        selection = { start: 7, end: 13 };
        await render();
        await raisePaste();
        await act(async () => offer?.resolve('attach', true));
        const prefix = 'before [pasted-context-1.txt]';
        expect(value).toBe(`${prefix} after`);
        expect(selection).toEqual({ start: prefix.length, end: prefix.length });
        editorRef.current?.insertText('§');
        expect(value).toBe(`${prefix}§ after`);
    });

    test('inline choice keeps subsequent typing after the pasted text', async () => {
        await render();
        await raisePaste();
        await act(async () => offer?.resolve('inline', true));
        const caret = 6 + pastedText.length;
        expect(selection).toEqual({ start: caret, end: caret });
        editorRef.current?.insertText('§');
        expect(value).toBe(`prefix${pastedText}§ suffix`);
        expect(attachedFiles).toEqual([]);
    });

    test('pending attachment does not delay caret restoration or change rejection behavior', async () => {
        let settle: (accepted: boolean) => void = () => {};
        attachmentResult = new Promise<boolean>((resolve) => { settle = resolve; });
        await render();
        await raisePaste();
        await act(async () => offer?.resolve('attach', true));
        const prefix = 'prefix [pasted-context-1.txt]';
        expect(value).toBe(`${prefix} suffix`);
        expect(selection).toEqual({ start: prefix.length, end: prefix.length });
        editorRef.current?.insertText('§');
        await act(async () => { settle(false); });
        expect(value).toBe(`${prefix}§ suffix`);
    });

    test('implicit resolution pastes without taking focus', async () => {
        await render();
        await raisePaste();
        await act(async () => offer?.resolve('inline', false));
        expect(focused).toBe(false);
        expect(value).toBe(`prefix${pastedText} suffix`);
        const caret = 6 + pastedText.length;
        expect(selection).toEqual({ start: caret, end: caret });
    });

    test('a stale offer cannot mutate the draft', async () => {
        await render();
        await raisePaste();
        const stale = offer;
        await act(async () => offer?.resolve('inline', true));
        const afterAccepted = value;
        await act(async () => stale?.resolve('attach', true));
        expect(value).toBe(afterAccepted);
        expect(attachedFiles).toEqual([]);
    });

    test('a superseded offer cannot insert a file or restore focus', async () => {
        await render();
        await raisePaste();
        const stale = offer;
        await raisePaste();
        await act(async () => stale?.resolve('attach', true));
        expect(value).toBe('prefix suffix');
        expect(focused).toBe(false);
        expect(attachedFiles).toEqual([]);
        await act(async () => offer?.resolve('inline', true));
        expect(value).toBe(`prefix${pastedText} suffix`);
    });
});
