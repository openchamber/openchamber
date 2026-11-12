import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePlaceholderFitsOneLine } from '../usePlaceholderFitsOneLine';

const CHAR_WIDTH = 7;

function Probe({ width, text, onResult }: { width: number; text: string; onResult: (fits: boolean) => void }) {
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const contentRef = React.useCallback((node: HTMLDivElement | null) => {
        if (node) Object.defineProperty(node, 'clientWidth', { value: width, configurable: true });
    }, [width]);
    onResult(usePlaceholderFitsOneLine(hostRef, text));
    return (
        <div ref={hostRef}>
            <div ref={contentRef} className="cm-content" />
        </div>
    );
}

describe('usePlaceholderFitsOneLine', () => {
    let browser: Window;
    let root: Root;
    let descriptors: Map<string, PropertyDescriptor | undefined>;

    beforeEach(() => {
        browser = new Window();
        // Every character is CHAR_WIDTH wide, whatever the font.
        Object.defineProperty(browser.HTMLCanvasElement.prototype, 'getContext', {
            configurable: true,
            value: () => ({ font: '', letterSpacing: '0px', measureText: (text: string) => ({ width: text.length * CHAR_WIDTH }) }),
        });
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, ResizeObserver: browser.ResizeObserver,
            getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        };
        descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        browser.close();
    });

    const render = async (width: number, text: string) => {
        let result: boolean | undefined;
        await act(async () => root.render(<Probe width={width} text={text} onResult={(fits) => { result = fits; }} />));
        return result;
    };

    const hint = 'x'.repeat(60);

    test('keeps the full text when the editor is wide enough for it', async () => {
        expect(await render(60 * CHAR_WIDTH, hint)).toBe(true);
    });

    test('reports a miss when the full text would wrap', async () => {
        expect(await render(60 * CHAR_WIDTH - 1, hint)).toBe(false);
    });

    test('follows a change of text at the same width', async () => {
        expect(await render(400, hint)).toBe(false);
        expect(await render(400, 'x'.repeat(40))).toBe(true);
    });

    test('keeps the full text while the editor has no width', async () => {
        expect(await render(0, hint)).toBe(true);
    });
});
