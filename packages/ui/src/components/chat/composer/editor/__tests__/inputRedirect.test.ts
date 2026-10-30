import { afterEach, beforeEach, expect, test } from 'bun:test';
import { EditorView } from '@codemirror/view';
import { Window } from 'happy-dom';

import { createComposerInputRedirect } from '../inputRedirect';

let browser: Window;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let views: EditorView[];

beforeEach(() => {
    browser = new Window({ url: 'http://localhost' });
    Object.defineProperty(browser.navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    const globals = {
        window: browser, document: browser.document, navigator: browser.navigator,
        HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
        MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
        Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, ClipboardEvent: browser.ClipboardEvent,
        MouseEvent: browser.MouseEvent, DataTransfer: browser.DataTransfer,
        requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
        cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
        getComputedStyle: browser.getComputedStyle.bind(browser),
    };
    descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    views = [];
});

afterEach(async () => {
    for (const view of views) view.destroy();
    document.body.replaceChildren();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    await browser.happyDOM.close();
});

function mountColumn(column: 'main' | 'pinned', doc = '') {
    const root = document.createElement('div');
    root.dataset.chatColumn = column;
    const host = document.createElement('div');
    host.dataset.chatInput = 'true';
    const button = document.createElement('button');
    const transcript = document.createElement('p');
    root.append(transcript, button, host);
    document.body.append(root);
    const view = new EditorView({ doc, parent: host });
    views.push(view);
    return { root, view, button, transcript };
}

const keydown = (key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

test('a printable key with nothing focused lands at the end of the main composer', () => {
    const main = mountColumn('main', 'draft');
    // The prompt navigator rail: a list that stays on screen.
    const rail = document.createElement('div');
    rail.setAttribute('role', 'listbox');
    main.root.append(rail);
    const redirect = createComposerInputRedirect();
    const event = keydown('x');
    document.body.dispatchEvent(event);

    expect(redirect.redirectKey(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(main.view.state.doc.toString()).toBe('draftx');
    expect(main.view.state.selection.main.head).toBe(6);
    expect(document.activeElement).toBe(main.view.contentDOM);
});

test('keys that belong elsewhere stay where they are', () => {
    const main = mountColumn('main');
    const redirect = createComposerInputRedirect();
    const field = document.createElement('input');
    document.body.append(field);

    const cases: Array<[EventTarget, KeyboardEvent]> = [
        [field, keydown('x')],
        [main.button, keydown(' ')],
        [document.body, keydown('Enter')],
        [document.body, keydown('k', { metaKey: true })],
        [document.body, keydown('k', { ctrlKey: true })],
        [document.body, keydown('x', { isComposing: true })],
    ];
    for (const [target, event] of cases) {
        target.dispatchEvent(event);
        expect(redirect.redirectKey(event)).toBe(false);
    }

    main.transcript.textContent = 'a reply';
    const range = document.createRange();
    range.selectNodeContents(main.transcript);
    window.getSelection()?.addRange(range);
    const overSelection = keydown('x');
    document.body.dispatchEvent(overSelection);
    expect(redirect.redirectKey(overSelection)).toBe(false);
    window.getSelection()?.removeAllRanges();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    const underDialog = keydown('x');
    document.body.dispatchEvent(underDialog);
    expect(redirect.redirectKey(underDialog)).toBe(false);
    expect(main.view.state.doc.toString()).toBe('');
});

test('a chat pinned in the side panel receives input after the user clicks into it', () => {
    const pinned = mountColumn('pinned');
    const main = mountColumn('main');
    const redirect = createComposerInputRedirect();
    document.addEventListener('pointerdown', redirect.rememberColumn, true);
    const clickInto = (element: Element) => element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const press = (key: string) => {
        const event = keydown(key);
        document.body.dispatchEvent(event);
        redirect.redirectKey(event);
    };

    press('a');
    clickInto(pinned.transcript);
    press('b');
    // A click outside any chat keeps the last one.
    clickInto(document.body);
    press('c');
    clickInto(main.transcript);
    press('d');

    expect(main.view.state.doc.toString()).toBe('ad');
    expect(pinned.view.state.doc.toString()).toBe('bc');

    clickInto(pinned.transcript);
    pinned.root.remove();
    press('e');
    expect(main.view.state.doc.toString()).toBe('ade');
});

test('a paste with nothing focused goes through the composer', () => {
    const main = mountColumn('main', 'draft ');
    const redirect = createComposerInputRedirect();
    const data = new DataTransfer();
    data.setData('text/plain', 'pasted');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(redirect.redirectPaste(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(main.view.state.doc.toString()).toBe('draft pasted');
});

const middlePointer = (target: EventTarget) => {
    const event = new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 1, clientX: 12, clientY: 8,
    });
    target.dispatchEvent(event);
    return event;
};

const middlePaste = (target: EventTarget, text = 'middle paste') => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { configurable: true, value: target });
    return event;
};

test('a middle click in the composer moves the caret and leaves native paste in place', () => {
    const main = mountColumn('main', 'draft');
    const redirect = createComposerInputRedirect();
    Object.defineProperty(main.view, 'posAtCoords', { configurable: true, value: () => 2 });
    redirect.rememberColumn(middlePointer(main.view.contentDOM));

    const paste = middlePaste(main.view.contentDOM);
    redirect.captureMiddleClickPaste(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(redirect.redirectPaste(paste)).toBe(false);
    expect(main.view.state.selection.main.head).toBe(2);
    expect(main.view.state.doc.toString()).toBe('draft');
});

test('a middle click on page chrome does not fall through to a focused composer', () => {
    const main = mountColumn('main', 'draft');
    const redirect = createComposerInputRedirect();
    redirect.rememberColumn(middlePointer(main.button));

    const paste = middlePaste(main.view.contentDOM);
    redirect.captureMiddleClickPaste(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(main.view.state.doc.toString()).toBe('draft');
});

test('a middle click in another text field stays native', () => {
    const redirect = createComposerInputRedirect();
    const field = document.createElement('input');
    document.body.append(field);
    redirect.rememberColumn(middlePointer(field));

    const paste = middlePaste(field);
    redirect.captureMiddleClickPaste(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(redirect.redirectPaste(paste)).toBe(false);
});

test('a middle click in a shadow-root field stays native', () => {
    const redirect = createComposerInputRedirect();
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const field = document.createElement('textarea');
    shadow.append(field);
    const path = () => [field, shadow, host, document, window];

    const pointer = new MouseEvent('pointerdown', { bubbles: true, button: 1 });
    Object.defineProperty(pointer, 'composedPath', { configurable: true, value: path });
    redirect.rememberColumn(pointer);

    const paste = middlePaste(host);
    Object.defineProperty(paste, 'composedPath', { configurable: true, value: path });
    redirect.captureMiddleClickPaste(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(redirect.redirectPaste(paste)).toBe(false);
});

test('a middle click in a terminal stays with that terminal', () => {
    const redirect = createComposerInputRedirect();
    const terminal = document.createElement('div');
    terminal.dataset.terminalOwner = 'main';
    const canvas = document.createElement('canvas');
    const input = document.createElement('textarea');
    terminal.append(canvas, input);
    document.body.append(terminal);
    redirect.rememberColumn(middlePointer(canvas));

    const paste = middlePaste(input, '');
    redirect.captureMiddleClickPaste(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(redirect.redirectPaste(paste)).toBe(false);
});

test('a keyboard paste a non-editable surface handles stays out of the composer', () => {
    const main = mountColumn('main', 'draft');
    const redirect = createComposerInputRedirect();
    const guest = document.createElement('div');
    guest.setAttribute('role', 'application');
    guest.addEventListener('paste', (event) => event.preventDefault());
    document.body.append(guest);
    window.addEventListener('paste', (event) => redirect.captureMiddleClickPaste(event), true);
    window.addEventListener('paste', (event) => redirect.redirectPaste(event));

    const paste = middlePaste(guest);
    guest.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(main.view.state.doc.toString()).toBe('draft');
});

test('Windows and macOS keep the existing unowned-paste fallback', () => {
    for (const [index, platform] of ['Win32', 'MacIntel'].entries()) {
        if (index > 0) {
            for (const view of views) view.destroy();
            views = [];
            document.body.replaceChildren();
        }
        Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
        const main = mountColumn('main', 'draft ');
        const redirect = createComposerInputRedirect();
        redirect.rememberColumn(middlePointer(document.body));

        const paste = middlePaste(document.body);

        expect(redirect.redirectPaste(paste)).toBe(true);
        expect(paste.defaultPrevented).toBe(true);
        expect(main.view.state.doc.toString()).toBe('draft middle paste');
    }
});

test('coming back to the window puts the caret in the composer unless focus takes text', () => {
    const main = mountColumn('main');
    const redirect = createComposerInputRedirect();

    main.button.focus();
    redirect.refocusAfterWindowFocus();
    expect(document.activeElement).toBe(main.view.contentDOM);

    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    redirect.refocusAfterWindowFocus();
    expect(document.activeElement).toBe(field);
});
