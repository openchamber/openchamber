import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import type { FilePart, Part } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from '../types';

import UserTextPart from './UserTextPart';

// Plain rendering keeps the lazy Markdown module out of this test graph.
// Markdown chip markup belongs to markdown/MarkdownLink.tsx.
useUIStore.setState({ userMessageRenderingMode: 'plain' });

const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
});

const DOM_GLOBAL_NAMES = [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'SVGElement',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    'ResizeObserver',
    'MutationObserver',
    'KeyboardEvent',
    'IS_REACT_ACT_ENVIRONMENT',
] as const;

class ResizeObserverStub implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

let restoreGlobals: () => void = () => undefined;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const values = {
        window: happyWindow,
        document: happyWindow.document,
        navigator: happyWindow.navigator,
        Node: happyWindow.Node,
        Element: happyWindow.Element,
        HTMLElement: happyWindow.HTMLElement,
        SVGElement: happyWindow.SVGElement,
        requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
        cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
        getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
        ResizeObserver: ResizeObserverStub,
        MutationObserver: happyWindow.MutationObserver,
        KeyboardEvent: happyWindow.KeyboardEvent,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const name of DOM_GLOBAL_NAMES) {
        Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    }
    restoreGlobals = () => {
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    restoreGlobals();
});

const textPart = (text: string): Part => ({
    id: 'prt_text',
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'text',
    text,
});

const filePart = (filename: string, mime: string, url: string): FilePart => ({
    id: `prt_${filename}`,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'file',
    mime,
    filename,
    url,
});

const PASTED = filePart('pasted-context-1.txt', 'text/plain', `data:text/plain;base64,${Buffer.from('what I pasted').toString('base64')}`);
const IMAGE = filePart('image-1.png', 'image/png', 'data:image/png;base64,iVBORw0KGgo=');
const BY_PATH = filePart('notes.md', 'text/plain', 'file:///repo/docs/notes.md');
const PDF = filePart('spec.pdf', 'application/pdf', 'data:application/pdf;base64,JVBERg==');
const FILES = [PASTED, IMAGE, BY_PATH, PDF];

const unavailable = (): never => { throw new Error('Attachment citations must not call these runtime APIs'); };
const vscodeRuntime = (openFile: (path: string) => Promise<void>): RuntimeAPIs => ({
    runtime: { platform: 'vscode', isDesktop: false, isVSCode: true },
    editor: { openFile, openDiff: async () => undefined },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
});

const renderMessage = async (text: string, options: { runtime?: RuntimeAPIs } = {}) => {
    const popups: ToolPopupContent[] = [];
    const part = (
        <UserTextPart
            part={textPart(text)}
            messageId="msg_1"
            isMobile={false}
            messageExpanded
            onExpandMessage={() => undefined}
            partIndex={0}
            onTruncationChange={() => undefined}
            attachmentFilenames={FILES.flatMap((file) => (file.filename ? [file.filename] : []))}
            attachmentFiles={FILES}
            onShowPopup={(content) => popups.push(content)}
        />
    );
    await act(async () => {
        root.render(
            <RuntimeAPIContext.Provider value={options.runtime ?? null}>
                <SyncProvider sdk={sdk} directory="">
                    <I18nProvider>{part}</I18nProvider>
                </SyncProvider>
            </RuntimeAPIContext.Provider>,
        );
    });
    return popups;
};

const chip = (filename: string): HTMLElement => {
    const element = container.querySelector<HTMLElement>(`[data-attachment-open="${filename}"]`);
    if (!element) throw new Error(`Expected an openable chip for ${filename}`);
    return element;
};

const captureOpenedFiles = () => {
    const opened: Array<{ directory: string; path: string }> = [];
    const original = useUIStore.getState().openContextFile;
    useUIStore.setState({ openContextFile: (directory, path) => { opened.push({ directory, path }); } });
    return { opened, restore: () => useUIStore.setState({ openContextFile: original }) };
};

describe('a file-name citation in a sent message', () => {
    test('a pasted text opens its text', async () => {
        const popups = await renderMessage('read [pasted-context-1.txt]');
        await act(async () => chip('pasted-context-1.txt').click());

        expect(popups).toHaveLength(1);
        expect(popups[0].content).toBe('what I pasted');
        expect(popups[0].image).toBeUndefined();
    });

    test('an image opens the image viewer', async () => {
        const popups = await renderMessage('look at [image-1.png]');
        await act(async () => chip('image-1.png').click());

        expect(popups).toHaveLength(1);
        expect(popups[0].image?.url).toBe(IMAGE.url);
    });

    test('a file attached by path opens that file in a Files tab', async () => {
        const files = captureOpenedFiles();
        try {
            const popups = await renderMessage('see [notes.md]');
            await act(async () => chip('notes.md').click());

            expect(files.opened.map((entry) => entry.path)).toEqual(['/repo/docs/notes.md']);
            expect(popups).toHaveLength(0);
        } finally {
            files.restore();
        }
    });

    test('in VS Code a file attached by path opens in the editor', async () => {
        const editorPaths: string[] = [];
        const files = captureOpenedFiles();
        try {
            await renderMessage('see [notes.md]', {
                runtime: vscodeRuntime(async (path) => { editorPaths.push(path); }),
            });
            await act(async () => chip('notes.md').click());

            expect(editorPaths).toEqual(['/repo/docs/notes.md']);
            expect(files.opened).toEqual([]);
        } finally {
            files.restore();
        }
    });

    test('a file the app cannot show stays a plain label', async () => {
        await renderMessage('the [spec.pdf] attached');

        expect(container.querySelector('[data-attachment-open="spec.pdf"]')).toBeNull();
        expect(container.querySelector('button')).toBeNull();
        expect(container.textContent).toContain('spec.pdf');
    });

    test('a click that ends a text selection over the chip keeps it closed', async () => {
        const popups = await renderMessage('read [pasted-context-1.txt] now');
        const target = chip('pasted-context-1.txt');
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        await act(async () => target.click());

        expect(popups).toHaveLength(0);
    });

    test('Enter and Space open the focusable chip the Markdown renderer draws', async () => {
        const popups = await renderMessage('read this');
        // The Markdown renderer's chip: a span with the button role, which
        // gets no click from the keyboard the way a real button does.
        const span = document.createElement('span');
        span.setAttribute('role', 'button');
        span.setAttribute('tabindex', '0');
        span.setAttribute('data-attachment-open', 'pasted-context-1.txt');
        container.querySelector('div.relative > div')?.appendChild(span);

        for (const key of ['Enter', ' ', 'a']) {
            await act(async () => {
                span.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            });
        }

        expect(popups.map((popup) => popup.content)).toEqual(['what I pasted', 'what I pasted']);
    });
});
