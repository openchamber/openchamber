import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';

import { LargeTextPasteChoice, type LargeTextPasteChoiceAction } from './LargeTextPasteChoice';

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

    const render = async (takeFocus = true) => {
        await act(async () => root.render(
            <I18nProvider>
                <LargeTextPasteChoice
                    takeFocus={takeFocus}
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
});
