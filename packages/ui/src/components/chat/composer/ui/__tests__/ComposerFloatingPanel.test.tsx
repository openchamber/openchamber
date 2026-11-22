import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

const { ComposerFloatingPanel } = await import('../ComposerFloatingPanel');
const { publishFloatingPanelClearance, registerComposerInsetReader } = await import('../../state/composerInsetReaders');

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;

describe('composer floating panel', () => {
    let happyWindow: Window;
    let restoreGlobals: () => void;
    let column: HTMLElement;
    let spacer: HTMLElement;
    let host: HTMLElement;
    let root: ReturnType<typeof createRoot>;
    let releaseSpacer: (() => void) | undefined;

    beforeEach(() => {
        happyWindow = new Window({ url: 'http://localhost' });
        const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        const values = {
            window: happyWindow,
            document: happyWindow.document,
            navigator: happyWindow.navigator,
            Node: happyWindow.Node,
            Element: happyWindow.Element,
            HTMLElement: happyWindow.HTMLElement,
            Event: happyWindow.Event,
            CustomEvent: happyWindow.CustomEvent,
            ResizeObserver: happyWindow.ResizeObserver,
            getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
            requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
            cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
        restoreGlobals = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        column = document.createElement('div');
        column.setAttribute('data-composer-bound', '');
        spacer = document.createElement('div');
        host = document.createElement('div');
        column.append(spacer, host);
        document.body.append(column);
        releaseSpacer = registerComposerInsetReader(spacer);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        releaseSpacer?.();
        restoreGlobals();
        void happyWindow.happyDOM.close();
    });

    test('a panel that mounts holding the room keeps the room the panel before it held', async () => {
        publishFloatingPanelClearance(column, { clearance: 44, tailReserve: 296 });
        await act(async () => root.render(<ComposerFloatingPanel header="Questions" compact holdReserve />));
        expect(spacer.style.getPropertyValue('--chat-floating-panel-reserve')).toBe('296px');
    });

    test('a panel that does not hold the room takes its own height', async () => {
        publishFloatingPanelClearance(column, { clearance: 44, tailReserve: 296 });
        await act(async () => root.render(<ComposerFloatingPanel header="Questions" compact />));
        expect(spacer.style.getPropertyValue('--chat-floating-panel-reserve')).toBe(spacer.style.getPropertyValue('--chat-floating-panel-clearance'));
    });
});
