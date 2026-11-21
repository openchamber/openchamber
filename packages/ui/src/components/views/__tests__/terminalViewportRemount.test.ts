import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { TerminalSurface, TerminalSurfaceFactory } from '@/components/terminal/TerminalViewport';
import type { TerminalChunk } from '@/stores/useTerminalStore';
import * as fontLoader from '@/lib/fontLoader';
import { I18nProvider } from '@/lib/i18n';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document });
const { TerminalViewport } = await import('../../terminal/TerminalViewport');

const theme = {
    background: '#000', foreground: '#fff', cursor: '#fff', cursorAccent: '#000',
    selectionBackground: '#333', selectionForeground: '#fff',
    black: '#000', red: '#f00', green: '#0f0', yellow: '#ff0', blue: '#00f', magenta: '#f0f', cyan: '#0ff', white: '#fff',
    brightBlack: '#777', brightRed: '#f00', brightGreen: '#0f0', brightYellow: '#ff0', brightBlue: '#00f', brightMagenta: '#f0f', brightCyan: '#0ff', brightWhite: '#fff',
};
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => { resolve = complete; });
    return { promise, resolve };
};
const writes: Array<{ kind: 'reset' | 'write'; data: string }> = [];
const themes: Array<Parameters<TerminalSurface['setTheme']>[0]> = [];
let creates = 0;
let disposals = 0;
let fontUpdates = 0;
const createSurface: TerminalSurfaceFactory = async () => {
    creates += 1;
    return {
        write: (data) => { writes.push({ kind: 'write', data }); },
        resetAndWrite: (data) => { writes.push({ kind: 'reset', data }); },
        setTheme: (next) => { themes.push(next); },
        setFont: async () => { fontUpdates += 1; },
        setVisible: () => {}, fit: () => true, refresh: () => {}, focus: () => {},
        getSelection: () => '', pasteFromClipboard: async () => {}, getSelectionPosition: () => null,
        scrollLines: () => {}, selectWordAt: () => false, extendSelectionTo: () => {},
        dispose: () => { disposals += 1; },
    };
};
let root: Root;
let host: HTMLDivElement;
let fontResult: Promise<void>;
let restoreFontLoad = () => {};
const render = (chunks: TerminalChunk[], fontSize = 14, nextTheme = theme) => act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(TerminalViewport, {
        sessionKey: 'tab', chunks, onInput: () => {}, onResize: () => {},
        theme: nextTheme, monoFont: 'system-mono', fontFamily: 'monospace', fontSize,
        createSurface, autoFocus: false,
    })));
});

beforeEach(() => {
    jest.useFakeTimers();
    Object.assign(globalThis, {
        window: browser, document: browser.document, navigator: browser.navigator,
        HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
        Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
        getComputedStyle: browser.getComputedStyle.bind(browser),
        requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true,
    });
    writes.length = 0;
    themes.length = 0;
    creates = 0;
    disposals = 0;
    fontUpdates = 0;
    fontResult = Promise.resolve();
    const fontLoad = spyOn(fontLoader, 'loadMonoFont').mockImplementation(() => fontResult);
    restoreFontLoad = () => fontLoad.mockRestore();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    restoreFontLoad();
    jest.useRealTimers();
});

describe('terminal viewport remount guard', () => {
    test('replay discontinuities reset the surface in place instead of remounting it', async () => {
        await render([{ id: 1, data: 'old', byteLength: 3 }]);
        writes.length = 0;
        await render([{ id: 9, data: 'new', byteLength: 3 }]);
        expect(writes).toEqual([{ kind: 'reset', data: 'new' }]);
        expect(creates).toBe(1);
        expect(disposals).toBe(0);
    });

    test('derives the initial PTY size before Ghostty mounts', async () => {
        const pending = deferred();
        fontResult = pending.promise;
        const reported: Array<[number, number]> = [];
        const width = Object.getOwnPropertyDescriptor(browser.HTMLElement.prototype, 'clientWidth');
        const height = Object.getOwnPropertyDescriptor(browser.HTMLElement.prototype, 'clientHeight');
        const getContext = Object.getOwnPropertyDescriptor(browser.HTMLCanvasElement.prototype, 'getContext')!;
        Object.defineProperty(browser.HTMLCanvasElement.prototype, 'getContext', {
            configurable: true,
            value: () => ({ font: '', measureText: () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 }) }),
        });
        Object.defineProperty(browser.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 808 });
        Object.defineProperty(browser.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 578 });
        try {
            await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(TerminalViewport, {
                sessionKey: 'tab', chunks: [], onInput: () => {}, onResize: () => {},
                onProvisionalSize: (cols, rows) => reported.push([cols, rows]),
                theme, monoFont: 'system-mono', fontFamily: 'monospace', fontSize: 14,
                createSurface, autoFocus: false,
            }))));
            expect(reported).toEqual([[100, 30]]);
            expect(creates).toBe(0);
        } finally {
            Object.defineProperty(browser.HTMLCanvasElement.prototype, 'getContext', getContext);
            if (width) Object.defineProperty(browser.HTMLElement.prototype, 'clientWidth', width);
            else Reflect.deleteProperty(browser.HTMLElement.prototype, 'clientWidth');
            if (height) Object.defineProperty(browser.HTMLElement.prototype, 'clientHeight', height);
            else Reflect.deleteProperty(browser.HTMLElement.prototype, 'clientHeight');
            await act(async () => pending.resolve());
        }
    });

    test('waits for the selected mono face with a bound before the surface measures the grid', async () => {
        fontResult = deferred().promise;
        await render([]);
        expect(creates).toBe(0);
        await act(async () => { jest.advanceTimersByTime(1999); });
        expect(creates).toBe(0);
        await act(async () => { jest.advanceTimersByTime(1); });
        expect(creates).toBe(1);
        const previousFonts = fontUpdates;
        const previousThemes = themes.length;
        await render([], 18, { ...theme, background: '#123456' });
        expect(fontUpdates).toBeGreaterThan(previousFonts);
        expect(themes.length).toBeGreaterThan(previousThemes);
        expect(themes.at(-1)?.background).toEqual({ r: 18, g: 52, b: 86 });
        expect(creates).toBe(1);
        expect(disposals).toBe(0);
    });
});
