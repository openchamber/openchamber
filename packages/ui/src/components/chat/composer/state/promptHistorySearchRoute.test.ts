import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

let windowInstance: Window | null = null;

afterEach(() => {
    windowInstance?.close();
    windowInstance = null;
});

test('routes a DOM keyboard event to its focused composer and unregisters its owner', async () => {
    windowInstance = new Window({ url: 'http://localhost' });
    Object.assign(globalThis, {
        window: windowInstance,
        document: windowInstance.document,
        Element: windowInstance.Element,
        HTMLElement: windowInstance.HTMLElement,
        Event: windowInstance.Event,
        KeyboardEvent: windowInstance.KeyboardEvent,
    });
    const { dispatchPromptHistorySearch, registerPromptHistorySearchRoute } = await import('./promptHistorySearchRoute');
    const firstInput = document.createElement('input');
    const secondInput = document.createElement('input');
    document.body.append(firstInput, secondInput);
    const calls: string[] = [];

    const removeFirst = registerPromptHistorySearchRoute(firstInput, () => {
        calls.push('first');
        return true;
    });
    registerPromptHistorySearchRoute(secondInput, () => {
        calls.push('second');
        return true;
    });
    firstInput.addEventListener('keydown', (event) => {
        if (dispatchPromptHistorySearch(event)) event.preventDefault();
    });

    const firstEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    firstInput.dispatchEvent(firstEvent);
    expect(calls).toEqual(['first']);
    expect(firstEvent.defaultPrevented).toBe(true);

    removeFirst();
    const unregisteredEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    firstInput.dispatchEvent(unregisteredEvent);
    expect(unregisteredEvent.defaultPrevented).toBe(false);
    expect(calls).toEqual(['first']);
});
