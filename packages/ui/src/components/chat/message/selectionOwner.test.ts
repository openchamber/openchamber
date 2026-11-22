import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { ownsSelection } from './selectionOwner';

describe('ownsSelection', () => {
    let restore: () => void;
    beforeAll(() => {
        const win = new Window();
        const globals = { document: win.document, Element: win.Element };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        document.body.innerHTML = `
            <div data-message-id="answer"><div id="answer" data-chat-quote-root="true">
                <div data-message-id="step"><div id="kept" data-chat-quote-root="true"><p id="note">Reading first</p></div></div>
                <p id="reply">All done</p>
            </div></div>`;
    });
    afterAll(() => restore());

    const owns = (rootId: string, textId: string): boolean => {
        const root = document.getElementById(rootId);
        const text = document.getElementById(textId);
        if (!root || !text) throw new Error('fixture element missing');
        const range = document.createRange();
        range.selectNodeContents(text);
        return ownsSelection(root, range);
    };

    test('text shown inside another message belongs to its own quote root, the rest to the answer', () => {
        expect(owns('kept', 'note')).toBe(true);
        expect(owns('answer', 'note')).toBe(false);
        expect(owns('answer', 'reply')).toBe(true);
        expect(owns('kept', 'reply')).toBe(false);
    });
});
