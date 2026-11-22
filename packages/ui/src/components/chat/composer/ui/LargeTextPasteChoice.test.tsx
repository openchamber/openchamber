import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { EditorView } from '@codemirror/view';

import { I18nProvider } from '@/lib/i18n';

import { createComposerInputRedirect } from '../editor/inputRedirect';

import { LargeTextPasteChoice, type LargeTextPasteChoiceAction, type LargeTextPasteChoiceKind } from './LargeTextPasteChoice';

describe('LargeTextPasteChoice', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let outside: HTMLButtonElement;
    let root: Root;
    let chosen: Array<[LargeTextPasteChoiceAction, boolean]>;
    let typed: string[];

    beforeEach(() => {
        windowInstance = new Window({ url: 'http://localhost' });
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            navigator: windowInstance.navigator,
            localStorage: windowInstance.localStorage,
            KeyboardEvent: windowInstance.KeyboardEvent,
            HTMLElement: windowInstance.HTMLElement,
            Element: windowInstance.Element,
            Node: windowInstance.Node,
            MutationObserver: windowInstance.MutationObserver,
            ResizeObserver: windowInstance.ResizeObserver,
            requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
            cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
            getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        host = document.createElement('div');
        outside = document.createElement('button');
        document.body.append(host, outside);
        root = createRoot(host);
        chosen = [];
        typed = [];
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        windowInstance.close();
    });

    const render = async (takeFocus = true, expanded = false, kind: LargeTextPasteChoiceKind = 'text') => {
        await act(async () => root.render(
            <I18nProvider>
                <LargeTextPasteChoice
                    kind={kind}
                    takeFocus={takeFocus}
                    expanded={expanded}
                    onChoose={(action, explicitlyChosen) => chosen.push([action, explicitlyChosen])}
                    onTypeThrough={(text) => typed.push(text)}
                />
            </I18nProvider>,
        ));
    };

    const press = async (key: string, init: { metaKey?: boolean } = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        await act(async () => {
            document.activeElement?.dispatchEvent(event);
        });
        return event;
    };

    const buttons = () => Array.from(host.querySelectorAll('button'));

    test('takes focus on "attach" and Enter picks it', async () => {
        await render();
        expect(document.activeElement).toBe(buttons()[0]);
        const event = await press('Enter');
        expect(event.defaultPrevented).toBe(true);
        expect(chosen).toEqual([['attach', true]]);
    });

    test('arrows and Tab switch between the two options', async () => {
        await render();
        await press('ArrowRight');
        expect(document.activeElement).toBe(buttons()[1]);
        await press('Tab');
        expect(document.activeElement).toBe(buttons()[0]);
        await press('ArrowLeft');
        await press('Enter');
        expect(chosen).toEqual([['inline', true]]);
    });

    test('Escape pastes inline', async () => {
        await render();
        await press('Escape');
        expect(chosen).toEqual([['inline', true]]);
    });

    test('a printable key types through; shortcuts do not', async () => {
        await render();
        await press('k', { metaKey: true });
        expect(typed).toEqual([]);
        const event = await press('a');
        expect(event.defaultPrevented).toBe(true);
        expect(typed).toEqual(['a']);
        expect(chosen).toEqual([]);
    });

    test('focus moving elsewhere pastes inline without counting as an answer', async () => {
        await render();
        await act(async () => outside.focus());
        expect(chosen).toEqual([['inline', false]]);
    });

    test('on mobile it leaves focus where it was', async () => {
        outside.focus();
        await render(false);
        expect(document.activeElement).toBe(outside);
    });

    test('for office documents it offers Attach as is first and Convert as the fallback', async () => {
        await render(true, false, 'documents');
        expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Office document detected');
        expect(buttons().map((button) => button.textContent)).toEqual(['Attach as is', 'Convert to text']);
        expect(document.activeElement).toBe(buttons()[0]);
        await press('Escape');
        expect(chosen).toEqual([['inline', true]]);
    });

    test('coming back to the window keeps the choice and its focus; moving focus elsewhere still answers', async () => {
        const column = document.createElement('div');
        column.dataset.chatColumn = 'main';
        const input = document.createElement('div');
        input.dataset.chatInput = 'true';
        column.append(input);
        document.body.append(column);
        const view = new EditorView({ doc: 'Please review ', parent: input });
        try {
            await render(true, false, 'documents');
            expect(document.activeElement).toBe(buttons()[0]);
            // A file dialog closing gives the window its focus back, and the
            // app's window-focus refocus runs while the choice is waiting.
            await act(async () => createComposerInputRedirect().refocusAfterWindowFocus());
            expect(document.activeElement).toBe(buttons()[0]);
            expect(chosen).toEqual([]);
            await act(async () => view.focus());
            expect(chosen).toEqual([['inline', false]]);
        } finally {
            view.destroy();
        }
    });

    test('an expanded composer anchors the pill inside its top edge', async () => {
        await render(true, true);
        const pill = host.querySelector('[role="group"]');
        expect(pill?.className).toContain('top-2');
        expect(pill?.className).toContain('inset-s-3');
        expect(pill?.className).toContain('z-50');
        expect(pill?.className).not.toContain('bottom-full');
        expect(pill?.className).not.toContain('mb-2');
    });
});
