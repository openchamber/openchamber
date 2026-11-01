import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useUIStore } from '@/stores/useUIStore';
import { useHtmlRenderTheme } from './useHtmlRenderTheme';
import type { HtmlRenderTheme } from './htmlRender';

test('rendered page typography follows committed settings, including parent font effects', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
        window: dom, document: dom.document, navigator: dom.navigator,
        Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
        getComputedStyle: dom.getComputedStyle.bind(dom),
        requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: (id: number) => { frames.delete(id); },
        IS_REACT_ACT_ENVIRONMENT: true,
    })) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import('react-dom/client');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const originalSettings = useUIStore.getState();
    const theme = getDefaultTheme(false);
    const context: ThemeContextValue = {
        currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
        setTheme: () => {}, reloadCustomThemes: async () => {}, importTheme: async () => theme,
        deleteImportedTheme: async () => {}, isSystemPreference: false, setSystemPreference: () => {},
        themeMode: 'light', setThemeMode: () => {}, lightThemeId: theme.metadata.id,
        darkThemeId: getDefaultTheme(true).metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
    };
    let delivered: HtmlRenderTheme | undefined;
    function PageTheme() {
        const value = useHtmlRenderTheme();
        React.useEffect(() => { delivered = value; }, [value]);
        return null;
    }
    function AppFonts({ children }: { children: React.ReactNode }) {
        useAppFontEffects();
        return children;
    }
    const flushFrames = () => act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
    });
    const expectCurrentTypography = () => {
        const style = getComputedStyle(document.documentElement);
        // happy-dom keeps percentage font sizes; the browser run checks px scaling.
        const rem = Number.parseFloat(style.fontSize) || 16;
        expect(delivered?.variables['--oc-rem']).toBe(`${rem}px`);
        const textScale = Number.parseFloat(style.getPropertyValue('--text-markdown')) || 0.875;
        expect(delivered?.variables['--oc-text']).toBe(`${rem * textScale}px`);
        expect(delivered?.variables['--font-sans']).toBe(style.getPropertyValue('--font-sans').trim());
        expect(delivered?.variables['--font-mono']).toBe(style.getPropertyValue('--font-mono').trim());
    };
    try {
        useUIStore.setState({ fontSize: 100, uiFont: 'system', monoFont: 'system-mono' });
        await act(async () => root.render(
            <ThemeSystemContext.Provider value={context}>
                <ThemeProvider><AppFonts><PageTheme /></AppFonts></ThemeProvider>
            </ThemeSystemContext.Provider>,
        ));
        await flushFrames();
        expectCurrentTypography();
        const previousTheme = delivered;
        await act(async () => useUIStore.setState({ isTimelineDialogOpen: true }));
        expect(frames.size).toBe(0);
        expect(delivered).toBe(previousTheme);
        await act(async () => useUIStore.getState().setFontSize(130));
        await flushFrames();
        expectCurrentTypography();
        await act(async () => {
            useUIStore.getState().setUiFont('custom');
            useUIStore.getState().setCustomUiFont('Georgia');
            useUIStore.getState().setMonoFont('custom');
            useUIStore.getState().setCustomMonoFont('Courier New');
        });
        await flushFrames();
        expectCurrentTypography();
        await act(async () => useUIStore.getState().setCustomUiFont('Arial'));
        await act(async () => {
            useUIStore.getState().setCustomUiFont('Verdana');
            useUIStore.getState().setCustomMonoFont('Consolas');
            useUIStore.getState().setFontSize(100);
        });
        await flushFrames();
        expectCurrentTypography();
        await act(async () => {
            document.documentElement.style.setProperty('--text-markdown', '1rem');
            root.render(
                <ThemeSystemContext.Provider value={{ ...context, currentTheme: getDefaultTheme(true) }}>
                    <ThemeProvider><AppFonts><PageTheme /></AppFonts></ThemeProvider>
                </ThemeSystemContext.Provider>,
            );
        });
        await flushFrames();
        expectCurrentTypography();
        expect(delivered?.appearance).toBe('dark');
        await act(async () => useUIStore.getState().setFontSize(120));
        await act(async () => root.unmount());
        expect(frames.size).toBe(0);
    } finally {
        await act(async () => root.unmount());
        useUIStore.setState(originalSettings);
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await dom.happyDOM.close();
    }
});
