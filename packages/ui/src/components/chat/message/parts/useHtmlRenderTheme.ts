import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useUIStore } from '@/stores/useUIStore';
import { htmlRenderTheme, type HtmlRenderMetrics, type HtmlRenderTheme } from './htmlRender';

const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_MONO = 'ui-monospace, "SFMono-Regular", Menlo, monospace';

// The phone text sizes in mobile.css are !important, so the chat's own scale,
// set inline on its column, does not reach the chat where they apply.
const usesPhoneTextSizes = () => (
    document.documentElement.matches('.mobile-pointer:not(.desktop-runtime)')
    && window.matchMedia('(max-width: 1024px)').matches
);

/** The user's font settings, as they land on the root and the chat column. */
const readRootMetrics = (chatFontSize: number): HtmlRenderMetrics => {
    const style = getComputedStyle(document.documentElement);
    const rem = Number.parseFloat(style.fontSize) || 16;
    // The chat's body text size, which the styles set in rem (0.875, and
    // 1 on phones), times the chat's own scale. The scale is read from the
    // setting: a full-screen page sits outside the chat column.
    const chatScale = usesPhoneTextSizes() ? 1 : chatFontSize / 100;
    const text = (Number.parseFloat(style.getPropertyValue('--text-markdown')) || 0.875) * rem * chatScale;
    return {
        rem,
        text,
        sans: style.getPropertyValue('--font-sans').trim() || DEFAULT_SANS,
        mono: style.getPropertyValue('--font-mono').trim() || DEFAULT_MONO,
    };
};

const sameMetrics = (a: HtmlRenderMetrics, b: HtmlRenderMetrics) => (
    a.rem === b.rem && a.text === b.text && a.sans === b.sans && a.mono === b.mono
);

/** The app theme as the page's variables, following theme, interface and chat size and font switches live. */
export function useHtmlRenderTheme(): HtmlRenderTheme {
    const { currentTheme } = useThemeSystem();
    const interfaceSize = useUIStore((state) => state.fontSize);
    const chatFontSize = useUIStore((state) => state.chatFontSize);
    const { uiFont, monoFont, customUiFont, customMonoFont } = useFontPreferences();
    const [metrics, setMetrics] = React.useState(() => readRootMetrics(chatFontSize));
    // The interface size and fonts reach the root in layout effects
    // (ThemeProvider, useAppFontEffects) that run after this component
    // renders, so a read during the render a setting change causes still
    // sees the old values. A passive effect runs after every layout effect.
    React.useEffect(() => {
        const next = readRootMetrics(chatFontSize);
        setMetrics((current) => (sameMetrics(current, next) ? current : next));
    }, [interfaceSize, chatFontSize, uiFont, monoFont, customUiFont, customMonoFont]);
    return React.useMemo(() => htmlRenderTheme(currentTheme, metrics), [currentTheme, metrics]);
}
