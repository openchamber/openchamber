import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { findTermRanges } from './chatSearchHighlight';
import { firstHitRange, resolveMatchScrollTarget } from './chatSearchReveal';

// A 600 px viewport whose visible band runs from 60 (under the top fade) to 480 (above the composer).
const band = { top: 60, bottom: 480 };

describe('resolveMatchScrollTarget', () => {
    test('a match already inside the visible band does not move the transcript', () => {
        expect(resolveMatchScrollTarget({ top: 1100, bottom: 1117 }, 1000, band, 5000)).toBeNull();
    });

    test('a match under the composer is centred in the visible band', () => {
        expect(resolveMatchScrollTarget({ top: 1500, bottom: 1520 }, 1000, band, 5000)).toBe(1240);
    });

    test('the target stays inside the scroll range', () => {
        expect(resolveMatchScrollTarget({ top: 4950, bottom: 4970 }, 1000, band, 4600)).toBe(4600);
        expect(resolveMatchScrollTarget({ top: 30, bottom: 47 }, 1000, band, 5000)).toBe(0);
    });
});

describe('firstHitRange', () => {
    let restore: () => void;
    beforeAll(() => {
        const win = new Window();
        const globals = { document: win.document, NodeFilter: win.NodeFilter, Range: win.Range };
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
                <div id="thinking" data-reasoning-message-id="answer"><div data-markdown-content><p>the reasoning names quillon</p></div></div>
                <div data-markdown-content><p>the answer names quillon</p></div>
            </div>`;
    });
    afterAll(() => restore());

    const first = (rootId: string, reasoning: boolean): string | null => {
        const root = document.getElementById(rootId);
        if (!root) throw new Error('fixture element missing');
        return firstHitRange(findTermRanges(root, ['quillon']), reasoning)?.startContainer.nodeValue ?? null;
    };

    test('an answer hit lands in the answer text, past the reasoning block drawn above it', () => {
        expect(first('answer', false)).toBe('the answer names quillon');
    });

    test('a reasoning hit lands in the reasoning text', () => {
        expect(first('thinking', true)).toBe('the reasoning names quillon');
    });
});
