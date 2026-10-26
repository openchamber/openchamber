import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { Part, UserMessage } from '@/lib/opencode/model';
import { useUIStore } from '@/stores/useUIStore';
import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import TurnItem from './TurnItem';

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const userTurn = (parts: Part[]): Turn => {
    const info: UserMessage = { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } };
    return { turnId: 'turn', userMessage: { info, parts }, assistantMessages: [] };
};
const textPart = (text: string): Part => ({ type: 'text', id: 'part', text, sessionID: 'session', messageID: 'user' });

const renderMessage = (message: ChatMessageEntry) => <div data-message-id={message.info.id} />;

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;

beforeEach(() => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const values = {
        window: happyWindow,
        document: happyWindow.document,
        navigator: happyWindow.navigator,
        HTMLElement: happyWindow.HTMLElement,
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

afterEach(() => {
    act(() => root.unmount());
    useUIStore.setState({ stickyUserHeader: false });
    restoreGlobals();
});

const render = (turn: Turn) => {
    act(() => root.render(<TurnItem turn={turn} renderMessage={renderMessage} assistantContent={<div data-work="" />} />));
};
const stickyHeader = () => container.querySelector('[data-turn-sticky-header]');

describe('TurnItem sticky user header', () => {
    test('keeps the prompt in the flow while the setting is off', () => {
        render(userTurn([textPart('Fix the build')]));

        expect(stickyHeader()).toBeNull();
        expect(container.querySelector('section > [data-message-id="user"]')).not.toBeNull();
    });

    test('pins the prompt above its work while the setting is on', () => {
        useUIStore.setState({ stickyUserHeader: true });
        render(userTurn([textPart('Fix the build')]));

        expect(stickyHeader()?.querySelector('[data-message-id="user"]')).not.toBeNull();
        // The follow stops read the turn's work as the element after the header.
        expect(container.querySelector('section')?.children[1]?.hasAttribute('data-work')).toBe(true);
    });

    test('pins nothing for a prompt the timeline hides', () => {
        useUIStore.setState({ stickyUserHeader: true });
        render(userTurn([]));

        expect(stickyHeader()).toBeNull();
    });

    test('follows the setting without remounting the turn', () => {
        render(userTurn([textPart('Fix the build')]));
        const section = container.querySelector('section');

        act(() => useUIStore.setState({ stickyUserHeader: true }));

        expect(stickyHeader()).not.toBeNull();
        expect(container.querySelector('section')).toBe(section);
    });
});
