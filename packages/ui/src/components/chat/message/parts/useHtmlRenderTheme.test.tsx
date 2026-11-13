import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { HtmlRenderTheme } from './htmlRender';

// React decides at import time whether a DOM exists, so the window comes first.
const win = new Window({ url: 'http://localhost' });
const browserGlobals = {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(Object.keys(browserGlobals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(browserGlobals)) Object.defineProperty(globalThis, key, { configurable: true, value });

const { createRoot } = await import('react-dom/client');
const { useAppFontEffects } = await import('@/apps/useAppFontEffects');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useUIStore } = await import('@/stores/useUIStore');
const { useHtmlRenderTheme } = await import('./useHtmlRenderTheme');

afterAll(async () => {
    for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
});

// The app's root writes, as the app makes them: the interface size in a
// parent's layout effect from the store (ThemeProvider; px here, since the
// test DOM does not resolve the app's percentage), the fonts through the
// app's own hook.
function AppRoot({ children }: { children: React.ReactNode }) {
    const fontSize = useUIStore((state) => state.fontSize);
    React.useLayoutEffect(() => {
        document.documentElement.style.fontSize = `${(16 * fontSize) / 100}px`;
    }, [fontSize]);
    useAppFontEffects();
    return children;
}

let theme: HtmlRenderTheme | null = null;
function Page() {
    theme = useHtmlRenderTheme();
    return null;
}
const pageVariable = (name: string) => theme?.variables[name];

describe('a drawn page follows the interface settings', () => {
    let root: Root;

    beforeEach(async () => {
        useUIStore.setState({ fontSize: 100, uiFont: 'custom', customUiFont: 'Inter' });
        root = createRoot(document.createElement('div'));
        await act(async () => root.render(<ThemeSystemProvider><AppRoot><Page /></AppRoot></ThemeSystemProvider>));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
    });

    test('takes the new interface size', async () => {
        expect(pageVariable('--oc-rem')).toBe('16px');
        await act(async () => useUIStore.setState({ fontSize: 130 }));
        expect(pageVariable('--oc-rem')).toBe('20.8px');
        expect(pageVariable('--oc-text')).toBe(`${0.875 * 20.8}px`);
    });

    test('takes the new interface font', async () => {
        expect(pageVariable('--font-sans')).toContain('"Inter"');
        await act(async () => useUIStore.setState({ customUiFont: 'Georgia' }));
        expect(pageVariable('--font-sans')).toContain('"Georgia"');
    });
});
