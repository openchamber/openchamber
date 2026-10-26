import { afterEach, beforeEach, expect, test } from 'bun:test';
import { EditorView } from '@codemirror/view';
import { Window } from 'happy-dom';

import { createComposerInputRedirect } from '../inputRedirect';

let browser: Window;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let views: EditorView[];

beforeEach(() => {
    browser = new Window({ url: 'http://localhost' });
    const globals = {
        window: browser, document: browser.document, navigator: browser.navigator,
        HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
        MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
        Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, ClipboardEvent: browser.ClipboardEvent,
        DataTransfer: browser.DataTransfer,
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
