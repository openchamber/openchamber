import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

// react-dom decides whether native input events are supported when it loads,
// so it and the panel are imported after the happy-dom globals exist.
type PanelModule = typeof import('./PromptHistorySearchPanel');

describe('PromptHistorySearchPanel', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;
    let createRoot: typeof import('react-dom/client').createRoot;
    let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
    let PromptHistorySearchPanel: PanelModule['PromptHistorySearchPanel'];
    const picked: string[] = [];
    const history = [
        { text: 'oldest prompt', attachments: [] },
        { text: 'middle prompt', attachments: [] },
        { text: 'newest full text prompt', attachments: [] },
    ];
    let closed: Array<'dismiss' | 'blur'>;

    beforeEach(async () => {
        windowInstance = new Window({ url: 'http://localhost' });
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            navigator: windowInstance.navigator,
            localStorage: windowInstance.localStorage,
            KeyboardEvent: windowInstance.KeyboardEvent,
            MouseEvent: windowInstance.MouseEvent,
            Event: windowInstance.Event,
            InputEvent: windowInstance.InputEvent,
            Element: windowInstance.Element,
            HTMLElement: windowInstance.HTMLElement,
            requestAnimationFrame: (callback: FrameRequestCallback) => windowInstance.setTimeout(() => callback(0), 0),
            cancelAnimationFrame: windowInstance.clearTimeout.bind(windowInstance),
            ResizeObserver: class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        HTMLElement.prototype.scrollIntoView = () => undefined;
        ({ createRoot } = await import('react-dom/client'));
        ({ I18nProvider } = await import('@/lib/i18n'));
        ({ PromptHistorySearchPanel } = await import('./PromptHistorySearchPanel'));
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        picked.length = 0;
        closed = [];
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        windowInstance.close();
    });

    async function render(olderRequest = 0, initialQuery = '', values = history) {
        await act(async () => root.render(
            <I18nProvider>
                <PromptHistorySearchPanel
                    history={values}
                    initialQuery={initialQuery}
                    olderRequest={olderRequest}
                    onPick={(candidate) => picked.push(candidate.value.text)}
                    onClose={(reason) => closed.push(reason)}
                />
            </I18nProvider>,
        ));
    }

    function searchInput(): HTMLInputElement {
        const input = host.querySelector<HTMLInputElement>('input');
        if (!input) throw new Error('search input is not rendered');
        return input;
    }

    async function press(key: string, init: KeyboardEventInit = {}, target: HTMLElement = searchInput()) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        await act(async () => target.dispatchEvent(event));
        return event;
    }

    async function type(value: string) {
        const input = searchInput();
        // Bypass React's value tracker, as a real keystroke would, so onChange fires.
        const setValue = Object.getOwnPropertyDescriptor(windowInstance.HTMLInputElement.prototype, 'value')?.set;
        setValue?.call(input, value);
        await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
    }

    function selectedText(): string {
        return host.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? '';
    }

    test('loads the newest matching prompt with Enter without submitting its containing form', async () => {
        await render();
        expect(host.querySelector('input')).not.toBeNull();
        const event = await press('Enter');
        expect(event.defaultPrevented).toBe(true);
        expect(picked).toEqual(['newest full text prompt']);
    });

    test('focuses the seeded query with its text selected', async () => {
        await render(0, 'full text');
        const input = searchInput();
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('full text');
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe('full text'.length);
    });

    test('filters full prompt text and picks the newest match', async () => {
        await render(0, 'full text');
        expect(host.querySelectorAll('[data-prompt-history-search-row]')).toHaveLength(1);
        await press('Enter');
        expect(picked).toEqual(['newest full text prompt']);
    });

    test('typing a query resets the selection to the newest match', async () => {
        await render();
        await press('ArrowUp');
        expect(selectedText()).toContain('middle prompt');
        await type('prompt');
        expect(host.querySelectorAll('[data-prompt-history-search-row]')).toHaveLength(3);
        expect(selectedText()).toContain('newest full text prompt');
        await press('Enter');
        expect(picked).toEqual(['newest full text prompt']);
    });

    test('bare arrows step older and newer without wrapping at either end', async () => {
        await render();
        await press('ArrowUp');
        expect(selectedText()).toContain('middle prompt');
        await press('ArrowUp');
        expect(selectedText()).toContain('oldest prompt');
        await press('ArrowUp');
        expect(selectedText()).toContain('oldest prompt');
        await press('ArrowDown');
        expect(selectedText()).toContain('middle prompt');
        await press('ArrowDown');
        await press('ArrowDown');
        expect(selectedText()).toContain('newest full text prompt');
    });

    test('Ctrl and Cmd arrows step through history away from the endpoints', async () => {
        await render();
        const ctrlUp = await press('ArrowUp', { ctrlKey: true });
        expect(ctrlUp.defaultPrevented).toBe(true);
        expect(selectedText()).toContain('middle prompt');
        await press('ArrowDown', { ctrlKey: true });
        expect(selectedText()).toContain('newest full text prompt');
        await press('ArrowUp', { metaKey: true });
        expect(selectedText()).toContain('middle prompt');
        await press('ArrowDown', { metaKey: true });
        expect(selectedText()).toContain('newest full text prompt');
    });

    test('Ctrl+P and Ctrl+N step older and newer', async () => {
        await render();
        const older = await press('p', { ctrlKey: true, code: 'KeyP' });
        expect(older.defaultPrevented).toBe(true);
        expect(selectedText()).toContain('middle prompt');
        await press('n', { ctrlKey: true, code: 'KeyN' });
        expect(selectedText()).toContain('newest full text prompt');
    });

    test('modified arrows and Home/End keep native behavior and do not move the highlight', async () => {
        await render();
        const shiftUp = await press('ArrowUp', { shiftKey: true });
        const ctrlShiftUp = await press('ArrowUp', { ctrlKey: true, shiftKey: true });
        const altUp = await press('ArrowUp', { altKey: true });
        const ctrlShiftP = await press('p', { ctrlKey: true, shiftKey: true, code: 'KeyP' });
        const home = await press('Home');
        const end = await press('End');
        for (const event of [shiftUp, ctrlShiftUp, altUp, ctrlShiftP, home, end]) {
            expect(event.defaultPrevented).toBe(false);
        }
        expect(selectedText()).toContain('newest full text prompt');
        expect(picked).toEqual([]);
    });

    test('modified arrows and Home/End bubble past the panel so outer bindings can handle them', async () => {
        await render();
        const reached: string[] = [];
        const record = (event: KeyboardEvent) => reached.push(event.key + event.altKey);
        host.addEventListener('keydown', record);
        try {
            await press('ArrowUp', { altKey: true });
            await press('ArrowDown', { shiftKey: true });
            await press('Home');
            await press('End');
        } finally {
            host.removeEventListener('keydown', record);
        }
        expect(reached).toEqual(['ArrowUptrue', 'ArrowDownfalse', 'Homefalse', 'Endfalse']);
    });

    test('the selected row carries the selected-style hook after keyboard navigation', async () => {
        await render();
        await press('ArrowUp');
        const rows = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
        const selected = rows.filter((row) => row.getAttribute('aria-selected') === 'true');
        expect(selected).toHaveLength(1);
        expect(selected[0]?.textContent).toContain('middle prompt');
        for (const row of rows) {
            expect(row.className).toContain('aria-selected:bg-interactive-selection');
        }
    });

    test('pointer presses inside the panel keep input focus, while buttons keep native focus', async () => {
        await render();
        const input = searchInput();
        const hint = host.querySelector<HTMLElement>('[data-prompt-history-search-hint]');
        if (!hint) throw new Error('hint is not rendered');
        const hintDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        await act(async () => hint.dispatchEvent(hintDown));
        expect(hintDown.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(input);

        const closeButton = host.querySelector<HTMLButtonElement>('[data-prompt-history-search-close]');
        if (!closeButton) throw new Error('close button is not rendered');
        const closeDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        // Native button focus stays with the browser; the panel does not cancel it.
        await act(async () => closeButton.dispatchEvent(closeDown));
        expect(closeDown.defaultPrevented).toBe(false);
        expect(closed).toEqual([]);
    });

    test('Ctrl+J and Ctrl+K are not cmdk vim bindings while editing the query', async () => {
        await render();
        const ctrlJ = await press('j', { ctrlKey: true, code: 'KeyJ' });
        const ctrlK = await press('k', { ctrlKey: true, code: 'KeyK' });
        expect(ctrlJ.defaultPrevented).toBe(false);
        expect(ctrlK.defaultPrevented).toBe(false);
        expect(selectedText()).toContain('newest full text prompt');
    });

    test('repeated open requests step older from the current selection', async () => {
        await render(0);
        await render(1);
        expect(selectedText()).toContain('middle prompt');
        await render(2);
        expect(selectedText()).toContain('oldest prompt');
    });

    test('restarts at the newest match when the history is replaced', async () => {
        await render();
        await press('ArrowUp');
        await render(0, '', [
            { text: 'replacement older', attachments: [] },
            { text: 'replacement newest', attachments: [] },
        ]);
        expect(selectedText()).toContain('replacement newest');
        await press('Enter');
        expect(picked).toEqual(['replacement newest']);
    });

    test('selects the newest result when empty history becomes populated', async () => {
        await render(0, '', []);
        await render(0, '', history);
        expect(selectedText()).toContain('newest full text prompt');
    });

    test('blocks form submission when Enter has no result and ignores IME composition', async () => {
        await render(0, 'absent');
        const noResultEnter = await press('Enter');
        const composingEnter = await press('Enter', { isComposing: true });
        expect(noResultEnter.defaultPrevented).toBe(true);
        expect(composingEnter.defaultPrevented).toBe(false);
        expect(picked).toEqual([]);
    });

    test('IME composition keeps Enter and arrows from picking or moving while a match is active', async () => {
        await render();
        const composingEnter = await press('Enter', { isComposing: true });
        const composingArrow = await press('ArrowUp', { isComposing: true });
        expect(composingEnter.defaultPrevented).toBe(false);
        expect(composingArrow.defaultPrevented).toBe(false);
        expect(picked).toEqual([]);
        expect(selectedText()).toContain('newest full text prompt');
    });

    test('shows the empty state when there is no history', async () => {
        await render(0, '', []);
        expect(host.querySelector('[data-prompt-history-search-empty]')).not.toBeNull();
        expect(host.querySelector('[data-prompt-history-search-no-matches]')).toBeNull();
    });

    test('shows the no-match state, not the empty state, when the query matches nothing', async () => {
        await render(0, 'absent');
        expect(host.querySelector('[data-prompt-history-search-no-matches]')).not.toBeNull();
        expect(host.querySelector('[data-prompt-history-search-empty]')).toBeNull();
        expect(host.querySelectorAll('[data-prompt-history-search-row]')).toHaveLength(0);
    });

    test('a seeded query with several matches still starts on the newest match', async () => {
        await render(0, 'prompt');
        expect(host.querySelectorAll('[data-prompt-history-search-row]')).toHaveLength(3);
        expect(selectedText()).toContain('newest full text prompt');
        await press('Enter');
        expect(picked).toEqual(['newest full text prompt']);
    });

    test('the close button uses its native activation and does not pick the highlighted row', async () => {
        await render();
        const closeButton = host.querySelector<HTMLButtonElement>('[data-prompt-history-search-close]');
        if (!closeButton) throw new Error('close button is not rendered');
        await act(async () => closeButton.click());
        expect(picked).toEqual([]);
        expect(closed).toEqual(['dismiss']);
    });

    test('Escape closes with dismiss', async () => {
        await render();
        const escape = await press('Escape');
        expect(escape.defaultPrevented).toBe(true);
        expect(closed).toEqual(['dismiss']);
    });

    test('focus leaving the panel closes it with blur', async () => {
        await render();
        const outside = document.createElement('button');
        document.body.append(outside);
        await act(async () => outside.focus());
        expect(closed).toEqual(['blur']);
        outside.remove();
    });

    test('clicking a row picks that prompt', async () => {
        await render();
        const row = host.querySelector<HTMLElement>('[data-prompt-history-search-row]');
        if (!row) throw new Error('no rows rendered');
        await act(async () => row.click());
        expect(picked).toEqual(['oldest prompt']);
    });

    test('aria-activedescendant names the highlighted row after keyboard navigation', async () => {
        await render();
        await press('ArrowUp');
        const selected = host.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
        expect(selected?.textContent).toContain('middle prompt');
        expect(searchInput().getAttribute('aria-activedescendant')).toBe(selected?.id);
    });

    test('keeps aria-activedescendant aligned with the newest filtered result', async () => {
        await render();
        await press('ArrowUp');
        await type('full text');
        const selected = host.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
        expect(selected?.textContent).toContain('newest full text prompt');
        expect(searchInput().getAttribute('aria-activedescendant')).toBe(selected?.id);
    });

    test('uses distinct input relationships for separate pinned composers', async () => {
        await act(async () => root.render(
            <I18nProvider>
                <PromptHistorySearchPanel history={history} initialQuery="" olderRequest={0} onPick={() => undefined} onClose={() => undefined} />
                <PromptHistorySearchPanel history={history} initialQuery="" olderRequest={0} onPick={() => undefined} onClose={() => undefined} />
            </I18nProvider>,
        ));
        const inputs = Array.from(host.querySelectorAll('input'));
        expect(inputs).toHaveLength(2);
        expect(inputs[0]?.getAttribute('aria-controls')).not.toBe(inputs[1]?.getAttribute('aria-controls'));
    });

    for (const clearance of [300, 140, 80, 0]) {
        test(`caps the whole panel with a ${clearance}px anchor clearance`, async () => {
            const main = document.createElement('main');
            document.body.append(main);
            const mainRoot = createRoot(main);
            const originalRect = HTMLElement.prototype.getBoundingClientRect;
            // Only the chat area's top and the composer anchor are measured here.
            HTMLElement.prototype.getBoundingClientRect = function measured(this: HTMLElement) {
                if (this === main) return new windowInstance.DOMRect(0, 0, 0, 0);
                if (this.hasAttribute('data-prompt-history-search')) return new windowInstance.DOMRect(0, clearance, 0, 0);
                return originalRect.call(this);
            };
            try {
                await act(async () => mainRoot.render(
                    <I18nProvider>
                        <PromptHistorySearchPanel history={history} initialQuery="" olderRequest={0} onPick={() => undefined} onClose={() => undefined} />
                    </I18nProvider>,
                ));
                const list = main.querySelector<HTMLElement>('[data-prompt-history-search-list]');
                const panel = main.querySelector<HTMLElement>('.oc-glass-popover');
                // Reserve the hook's 8px boundary and the floating frame's 12px gap.
                // Flex layout gives the scrollable list whatever the actual chrome leaves.
                expect(Number.parseFloat(panel?.style.maxHeight ?? '')).toBe(Math.max(0, clearance - 8 - 12));
                expect(panel?.classList.contains('flex-col')).toBe(true);
                expect(list?.style.maxHeight).toBe('320px');
                expect(list?.classList.contains('flex-1')).toBe(true);
            } finally {
                HTMLElement.prototype.getBoundingClientRect = originalRect;
                await act(async () => mainRoot.unmount());
                main.remove();
            }
        });
    }
});
