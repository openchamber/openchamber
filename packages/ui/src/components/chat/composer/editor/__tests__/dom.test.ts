import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { focusChatInput } from '../dom';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let win: Window;

const composer = (column: 'main' | 'pinned') => `
    <div data-chat-column="${column}">
        <div data-chat-input="true"><div class="cm-content" tabindex="0" id="${column}-editor"></div></div>
    </div>`;

beforeEach(() => {
    win = new Window({ url: 'http://localhost' });
    Object.defineProperty(globalThis, 'document', { value: win.document, configurable: true, writable: true });
});

afterEach(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    void win.happyDOM.close();
});

test('focuses the CodeMirror chat input content', () => {
    win.document.body.innerHTML = composer('main');

    focusChatInput();

    expect(win.document.activeElement?.id).toBe('main-editor');
});

test('skips a chat pinned in the side panel, wherever it sits in the page', () => {
    win.document.body.innerHTML = composer('pinned') + composer('main');

    focusChatInput();

    expect(win.document.activeElement?.id).toBe('main-editor');
});
