import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useUIStore } from '@/stores/useUIStore';
import { htmlRenderTheme, type HtmlRenderMetrics, type HtmlRenderTheme } from './htmlRender';

const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_MONO = 'ui-monospace, "SFMono-Regular", Menlo, monospace';

/** The user's font settings, as they land on the root. */
const readRootMetrics = (): HtmlRenderMetrics => {
    const style = getComputedStyle(document.documentElement);
    const rem = Number.parseFloat(style.fontSize) || 16;
    // The chat's body text size, which the styles set in rem (0.875, and
    // 1 on phones).
    const text = (Number.parseFloat(style.getPropertyValue('--text-markdown')) || 0.875) * rem;
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

/** The app theme as the page's variables, following theme, interface size and font switches live. */
export function useHtmlRenderTheme(): HtmlRenderTheme {
    const { currentTheme } = useThemeSystem();
    const interfaceSize = useUIStore((state) => state.fontSize);
    const { uiFont, monoFont, customUiFont, customMonoFont } = useFontPreferences();
    const [metrics, setMetrics] = React.useState(readRootMetrics);
    // The interface size and fonts reach the root in layout effects
    // (ThemeProvider, useAppFontEffects) that run after this component
    // renders, so a read during the render a setting change causes still
    // sees the old values. A passive effect runs after every layout effect.
    React.useEffect(() => {
        const next = readRootMetrics();
        setMetrics((current) => (sameMetrics(current, next) ? current : next));
    }, [interfaceSize, uiFont, monoFont, customUiFont, customMonoFont]);
    return React.useMemo(() => htmlRenderTheme(currentTheme, metrics), [currentTheme, metrics]);
}
