import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useUIStore } from '@/stores/useUIStore';
import { htmlRenderTheme, type HtmlRenderMetrics, type HtmlRenderTheme } from './htmlRender';

const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_MONO = 'ui-monospace, "SFMono-Regular", Menlo, monospace';

const usesPhoneTextSizes = () => (
    document.documentElement.matches('.mobile-pointer:not(.desktop-runtime)')
    && window.matchMedia('(max-width: 1024px)').matches
);

const readRootMetrics = (chatFontSize: number): HtmlRenderMetrics => {
    const style = getComputedStyle(document.documentElement);
    const rem = Number.parseFloat(style.fontSize) || 16;
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

export function useHtmlRenderTheme(): HtmlRenderTheme {
    const { currentTheme } = useThemeSystem();
    const interfaceSize = useUIStore((state) => state.fontSize);
    const chatFontSize = useUIStore((state) => state.chatFontSize);
    const { uiFont, monoFont, customUiFont, customMonoFont } = useFontPreferences();
    const [metrics, setMetrics] = React.useState(() => readRootMetrics(chatFontSize));
    React.useEffect(() => {
        const next = readRootMetrics(chatFontSize);
        setMetrics((current) => (sameMetrics(current, next) ? current : next));
    }, [interfaceSize, chatFontSize, uiFont, monoFont, customUiFont, customMonoFont]);
    return React.useMemo(() => htmlRenderTheme(currentTheme, metrics), [currentTheme, metrics]);
}
