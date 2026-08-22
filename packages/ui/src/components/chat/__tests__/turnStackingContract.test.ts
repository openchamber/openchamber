import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import TurnItem from '../components/TurnItem';
import type { ChatMessageEntry, Turn } from '../lib/turns/types';

/**
 * Regression contract for #2094 / #2095 / #2119 (one root cause).
 *
 * Every turn's sticky user header is z-20 and its assistant block is z-0.
 * Turn <section>s must therefore be isolated stacking contexts: without
 * `isolation: isolate` all headers and assistant blocks share the scroll
 * container's single stacking context, and any geometric overlap between
 * adjacent turns (virtualizer measurement lag at the history/streaming-tail
 * seam) lets one turn's stuck header paint over another turn's content —
 * the reversed visual order, hidden action buttons, and cropped messages
 * reported in the three issues.
 *
 * These are structural (server-rendered markup + source) assertions, not
 * paint tests: they prove the DOM contract the fix established — per-turn
 * isolation, a single unambiguous position on the sticky header, and a
 * min-height (never fixed-height / transform) virtualizer size container —
 * and they trip if any of those regress. Actual paint order was verified in
 * a real browser during the fix (headless Chrome hit-testing).
 */

const messageEntry = (id: string): ChatMessageEntry => ({
    info: { id } as ChatMessageEntry['info'],
    parts: [],
});

const turn: Turn = {
    turnId: 'turn-a',
    userMessage: messageEntry('user-a'),
    assistantMessages: [messageEntry('assistant-a')],
};

const renderMessage = (message: ChatMessageEntry): ReactNode =>
    createElement('div', { 'data-msg': message.info.id });

const renderTurn = (stickyUserHeader: boolean) =>
    renderToStaticMarkup(createElement(TurnItem, { turn, stickyUserHeader, renderMessage }));

const classTokens = (markup: string, matcher: RegExp): string[] => {
    const match = markup.match(matcher);
    if (!match) return [];
    return match[1].split(/\s+/).filter(Boolean);
};

describe('turn stacking contract (#2094, #2095, #2119)', () => {
    test('turn section is an isolated stacking context', () => {
        const markup = renderTurn(true);
        const sectionClasses = classTokens(markup, /<section class="([^"]*)"/);
        expect(sectionClasses).toContain('isolate');
        expect(sectionClasses).toContain('relative');
    });

    test('sticky user header declares exactly one position', () => {
        const markup = renderTurn(true);
        const headerClasses = classTokens(markup, /<div class="([^"]*sticky[^"]*)"/);
        expect(headerClasses).toContain('sticky');
        expect(headerClasses).toContain('top-0');
        expect(headerClasses).toContain('z-20');
        // `relative` alongside `sticky` made the header's position depend on
        // utility cascade order; the header must carry a single position.
        expect(headerClasses).not.toContain('relative');
    });

    test('assistant block stays a z-0 layer inside the turn', () => {
        const markup = renderTurn(true);
        expect(markup).toContain('<div class="relative z-0">');
    });

    test('non-sticky render path keeps the same isolated section', () => {
        const markup = renderTurn(false);
        expect(markup).not.toContain('sticky');
        const sectionClasses = classTokens(markup, /<section class="([^"]*)"/);
        expect(sectionClasses).toContain('isolate');
    });
});

describe('virtualized history seam contract (#2119)', () => {
    // Source-level tripwire: StaticHistoryList is not exported and renders
    // only under a live virtualizer, so the invariants are asserted against
    // the source. This proves the structural fix is in place, not paint
    // behavior.
    const messageListSource = readFileSync(
        new URL('../MessageList.tsx', import.meta.url),
        'utf8'
    );

    test('size container uses min-height so overflowing rows push the tail down instead of overlapping it', () => {
        expect(messageListSource).toContain('style={{ minHeight: tanstackVirtualizer.getTotalSize() }}');
        expect(messageListSource).not.toContain('style={{ height: tanstackVirtualizer.getTotalSize() }}');
        // The eager pre-scroll write must target the same property the render
        // path owns, or React and the manual write fight over two properties.
        expect(messageListSource).toContain('sizeElement.style.minHeight');
        expect(messageListSource).not.toContain('sizeElement.style.height =');
    });

    test('virtual window offset stays padding-based; a transform ancestor would break sticky headers again', () => {
        expect(messageListSource).toContain('paddingTop: `${startOffset}px`');
        expect(messageListSource).not.toContain('translateY(${startOffset}px)');
    });
});
