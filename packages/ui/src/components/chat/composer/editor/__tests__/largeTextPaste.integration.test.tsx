import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerEditor, type ComposerEditorHandle } from '../ComposerEditor';
import { LargeTextPasteGesture } from '../../largeTextPaste';
import type { ComposerLanguageContext } from '../../language/tokenize';

const languageContext: ComposerLanguageContext = {
    inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(),
    knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [],
};

describe('mounted composer native paste and double-paste conversion', () => {
    let browser: Window;
    let root: Root;
    let host: HTMLDivElement;
    let descriptors: Map<string, PropertyDescriptor | undefined>;
    let gesture: LargeTextPasteGesture;
    const editor = React.createRef<ComposerEditorHandle>();
    const text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\r\n');
    let attaches: number;
    let nativeChanges: number;
    let acceptAttachment: boolean;

    beforeEach(async () => {
        browser = new Window();
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        };
        descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        host = document.createElement('div'); document.body.append(host); root = createRoot(host);
        gesture = new LargeTextPasteGesture(); attaches = 0; nativeChanges = 0; acceptAttachment = true;
        const read = () => {
            if (!editor.current) return null;
            return { value: editor.current.getValue(), selection: editor.current.getSelection(), scope: 'draft' };
        };
        await act(async () => root.render(
            <form onContextMenuCapture={() => gesture.invalidate()}>
            <ComposerEditor ref={editor} value="before  after" languageContext={languageContext}
                onKeyDown={(event) => { gesture.keyDown(event); return false; }}
                onKeyUp={(event) => gesture.keyUp(event)}
                onSelectionChange={() => gesture.invalidate()}
                onBlur={() => gesture.invalidate()}
                onChange={(change) => {
                    if (change.fromPaste) nativeChanges++;
                    gesture.change({ ...change, scope: 'draft' });
                }}
                onPaste={(event) => {
                    const snapshot = read();
                    if (!snapshot || !event.clipboardData) return;
                    const candidate = gesture.beginPaste(event.clipboardData.getData('text/plain'), snapshot);
                    if (!candidate) return;
                    event.preventDefault();
                    void gesture.convert(candidate, async () => { attaches++; return acceptAttachment; }, read,
                        (from, to, citation) => editor.current?.replaceRange(from, to, citation), '[pasted-context-1.txt]');
                }}
            />
            </form>,
        ));
        await act(async () => { editor.current?.focus(); editor.current?.setSelection(7); });
    });

    afterEach(async () => {
        gesture.invalidate(); await act(async () => root.unmount()); browser.close();
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    async function paste(keyboard = true, repeat = false, metaKey = false, key = 'v', code = 'KeyV') {
        const content = browser.document.querySelector('.cm-content');
        if (!content) throw new Error('Composer not mounted');
        await act(async () => {
            if (keyboard) content.dispatchEvent(new browser.KeyboardEvent('keydown', { key, code, ctrlKey: !metaKey, metaKey, repeat, bubbles: true, cancelable: true }));
            const clipboardData = new browser.DataTransfer(); clipboardData.setData('text/plain', text);
            content.dispatchEvent(new browser.ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
            if (keyboard) content.dispatchEvent(new browser.KeyboardEvent('keyup', { key, code, bubbles: true }));
        });
    }

    test('native first paste reports fromPaste; a second shortcut converts exactly that insertion', async () => {
        await paste();
        expect(editor.current?.getValue()).toBe(`before ${text.replaceAll('\r\n', '\n')} after`);
        expect(nativeChanges).toBe(1); expect(attaches).toBe(0);
        await paste();
        expect(attaches).toBe(1); expect(nativeChanges).toBe(1);
        expect(editor.current?.getValue()).toBe('before [pasted-context-1.txt] after');
    });

    test('menu paste and repeated keydown remain native', async () => {
        await paste(); await paste(false); await paste(true, true);
        expect(attaches).toBe(0); expect(nativeChanges).toBe(3);
    });

    test('rejected attachment retains the first native insertion', async () => {
        acceptAttachment = false; await paste(); const inline = editor.current?.getValue(); await paste();
        expect(attaches).toBe(1); expect(editor.current?.getValue()).toBe(inline);
    });

    test('Cmd+V uses the same conversion path', async () => {
        await paste(true, false, true); await paste(true, false, true);
        expect(attaches).toBe(1); expect(editor.current?.getValue()).toBe('before [pasted-context-1.txt] after');
    });

    for (const metaKey of [false, true]) test(`${metaKey ? 'Cmd' : 'Ctrl'}+V converts the native paste with a Cyrillic layout`, async () => {
        await paste(true, false, metaKey, 'м');
        await paste(true, false, metaKey, 'м');
        expect(attaches).toBe(1);
        expect(nativeChanges).toBe(1);
        expect(editor.current?.getValue()).toBe('before [pasted-context-1.txt] after');
    });

    test('Dvorak V follows the character rather than its physical position', async () => {
        await paste(true, false, false, 'v', 'Period');
        await paste(true, false, false, 'v', 'Period');
        expect(attaches).toBe(1);
        expect(editor.current?.getValue()).toBe('before [pasted-context-1.txt] after');
    });

    test('a non-Latin key release cancels a shortcut that did not deliver a paste', async () => {
        await paste(true, false, false, 'м');
        const content = browser.document.querySelector('.cm-content');
        if (!content) throw new Error('Composer not mounted');
        await act(async () => {
            content.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'м', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }));
            content.dispatchEvent(new browser.KeyboardEvent('keyup', { key: 'м', code: 'KeyV', bubbles: true }));
        });
        await paste(false);
        expect(attaches).toBe(0);
        expect(nativeChanges).toBe(2);
    });

    test('opening the context menu cancels a keyboard press that did not deliver a paste', async () => {
        await paste();
        const content = browser.document.querySelector('.cm-content');
        if (!content) throw new Error('Composer not mounted');
        await act(async () => {
            content.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
            content.dispatchEvent(new browser.MouseEvent('contextmenu', { bubbles: true }));
        });
        await paste(false); expect(attaches).toBe(0); expect(nativeChanges).toBe(2);
    });

    for (const reset of ['selection', 'blur', 'edit']) test(`editor ${reset} invalidates the first paste`, async () => {
        await paste();
        await act(async () => {
            if (reset === 'selection') {
                editor.current?.setSelection(0); editor.current?.setSelection(editor.current.getValue().length - 6);
            } else if (reset === 'blur') {
                editor.current?.blur(); editor.current?.focus();
            } else editor.current?.insertText('edited');
        });
        await paste(); expect(attaches).toBe(0); expect(nativeChanges).toBe(2);
    });
});
