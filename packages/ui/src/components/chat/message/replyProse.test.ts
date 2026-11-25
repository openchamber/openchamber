import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { findReplyProseElement } from './replyProse';

const browser = new Window();
Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: browser.document });

const build = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    const message = document.body.querySelector<HTMLElement>('[data-message-id="msg_1"]');
    if (!message) {
        throw new Error('fixture is missing its message element');
    }
    return message;
};

describe('findReplyProseElement', () => {
    test('skips a reasoning trace drawn as plain text before the answer', () => {
        const root = build(`
            <div data-message-id="msg_1">
                <div class="group/assistant-text relative break-words" data-reasoning-inline="true">Thinking about the answer</div>
                <div data-message-text-export-source="true">The answer</div>
            </div>
        `);

        expect(findReplyProseElement(root)?.textContent).toBe('The answer');
    });

    test('skips reasoning inside a collapsible block', () => {
        const root = build(`
            <div data-message-id="msg_1">
                <div data-reasoning-block-id="reasoning-1">
                    <div data-message-text-export-source="true">Thinking about the answer</div>
                </div>
                <div data-message-text-export-source="true">The answer</div>
            </div>
        `);

        expect(findReplyProseElement(root)?.textContent).toBe('The answer');
    });

    test('does not read a styling class as prose', () => {
        const root = build(`
            <div data-message-id="msg_1">
                <div class="group/assistant-text relative break-words">The answer</div>
            </div>
        `);

        expect(findReplyProseElement(root)).toBeNull();
    });

    test('returns null when the message only holds reasoning', () => {
        const root = build(`
            <div data-message-id="msg_1">
                <div data-message-text-export-source="true" data-reasoning-inline="true">Thinking</div>
            </div>
        `);

        expect(findReplyProseElement(root)).toBeNull();
    });
});
