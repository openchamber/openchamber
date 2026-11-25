import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { MESSAGE_JUMP_GAP_PX, REPLY_START_GAP_PX } from './scrollGaps';
import { readStuckHeaderHeight, replyTopInset } from './replyTopInset';

const browser = new Window();
Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: browser.document });
Object.defineProperty(globalThis, 'CSS', { configurable: true, writable: true, value: browser.CSS });

// SAFETY: the production code reads only the rectangle fields set here; happy-dom does not implement the rest of DOMRect.
const rect = (top: number, height: number): DOMRect => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
}) as DOMRect;

const stubRect = (element: Element, box: DOMRect): void => {
    Object.defineProperty(element, 'getBoundingClientRect', { value: () => box, configurable: true });
};

const container = (): HTMLElement => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    stubRect(root, rect(48, 600));
    return root;
};

const addTurnHead = (root: HTMLElement, turnId: string, headerHeight: number): HTMLElement => {
    const head = document.createElement('section');
    head.dataset.turnId = turnId;
    const header = document.createElement('div');
    header.dataset.turnStickyHeader = '';
    head.append(header);
    stubRect(header, rect(48, headerHeight));
    root.append(head);
    return header;
};

const addReply = (root: HTMLElement, turnId: string, proseTop: number): HTMLElement => {
    const row = document.createElement('div');
    row.dataset.turnRow = turnId;
    const prose = document.createElement('div');
    prose.textContent = 'Answer';
    row.append(prose);
    stubRect(prose, rect(proseTop, 40));
    root.append(row);
    return prose;
};

describe('readStuckHeaderHeight', () => {
    test('counts only a header pinned at the container top', () => {
        const root = container();
        const pinned = addTurnHead(root, 'turn_1', 132);
        const below = document.createElement('div');
        below.dataset.turnStickyHeader = '';
        stubRect(below, rect(500, 160));
        root.append(below);

        expect(readStuckHeaderHeight(root)).toBe(132);
        expect(pinned.dataset.turnId).toBeUndefined();
    });

    test('is zero when no header covers the top', () => {
        const root = container();
        const below = document.createElement('div');
        below.dataset.turnStickyHeader = '';
        stubRect(below, rect(300, 160));
        root.append(below);

        expect(readStuckHeaderHeight(root)).toBe(0);
    });
});

describe('replyTopInset', () => {
    test('clears the reply turn own sticky header', () => {
        const root = container();
        addTurnHead(root, 'turn_1', 132);
        const prose = addReply(root, 'turn_1', 400);

        expect(replyTopInset(root, prose)).toBe(132 + REPLY_START_GAP_PX);
    });

    test('falls back to the header stuck over the viewport when the reply turn head is not mounted', () => {
        const root = container();
        addTurnHead(root, 'turn_0', 132);
        const prose = addReply(root, 'turn_1', 400);

        expect(replyTopInset(root, prose)).toBe(132 + REPLY_START_GAP_PX);
    });

    test('falls back when the reply turn header has no height yet', () => {
        const root = container();
        addTurnHead(root, 'turn_0', 132);
        addTurnHead(root, 'turn_1', 0);
        const prose = addReply(root, 'turn_1', 400);

        expect(replyTopInset(root, prose)).toBe(132 + REPLY_START_GAP_PX);
    });

    test('keeps the plain message gap when nothing sticks', () => {
        const root = container();
        const prose = addReply(root, 'turn_1', 400);

        expect(replyTopInset(root, prose)).toBe(MESSAGE_JUMP_GAP_PX);
    });
});
