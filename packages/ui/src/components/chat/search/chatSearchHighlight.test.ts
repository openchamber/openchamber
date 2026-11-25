import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { findTermRanges } from './chatSearchHighlight';

describe('findTermRanges', () => {
    let restore: () => void;
    beforeAll(() => {
        const win = new Window();
        const globals = { document: win.document, NodeFilter: win.NodeFilter };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        document.body.innerHTML = `
            <div id="answer" data-message-id="answer">
                <div id="thinking" data-reasoning-message-id="answer"><div data-markdown-content><p>maybe a helper</p></div></div>
                <div id="kept" data-message-id="step"><div data-markdown-content><p>reading the helper</p></div></div>
                <div data-markdown-content><p>the helper is fixed</p></div>
            </div>`;
    });
    afterAll(() => restore());

    const found = (rootId: string): string[] => {
        const root = document.getElementById(rootId);
        if (!root) throw new Error('fixture element missing');
        return findTermRanges(root, ['helper']).map((range) => range.startContainer.nodeValue ?? '');
    };

    test('a message does not claim the text of another message shown inside it', () => {
        expect(found('answer')).toEqual(['the helper is fixed']);
        expect(found('kept')).toEqual(['reading the helper']);
        expect(found('thinking')).toEqual(['maybe a helper']);
    });

    test('a Markdown prompt, whose bubble holds the Markdown container, has each match once', () => {
        document.body.insertAdjacentHTML('beforeend', '<div id="prompt" data-message-id="prompt"><div data-user-message-bubble><div data-markdown-content><p>one quokka, two quokka</p></div></div></div>');
        const root = document.getElementById('prompt');
        if (!root) throw new Error('fixture element missing');
        expect(findTermRanges(root, ['quokka'])).toHaveLength(2);
    });

    test('matches of several words come in reading order, so the next match is the one below', () => {
        const root = document.getElementById('answer');
        if (!root) throw new Error('fixture element missing');
        expect(findTermRanges(root, ['helper', 'the']).map((range) => range.toString())).toEqual(['the', 'helper']);
    });
});
