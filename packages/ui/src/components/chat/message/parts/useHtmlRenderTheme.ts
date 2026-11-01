import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useUIStore } from '@/stores/useUIStore';
import { htmlRenderTheme, type HtmlRenderTheme } from './htmlRender';

const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_MONO = 'ui-monospace, "SFMono-Regular", Menlo, monospace';

function readTypography() {
    const style = getComputedStyle(document.documentElement);
    const rem = Number.parseFloat(style.fontSize) || 16;
    return {
        rem,
        text: (Number.parseFloat(style.getPropertyValue('--text-markdown')) || 0.875) * rem,
        sans: style.getPropertyValue('--font-sans').trim() || DEFAULT_SANS,
        mono: style.getPropertyValue('--font-mono').trim() || DEFAULT_MONO,
    };
}

/** The page's theme and typography, shared by inline/full-screen frames and downloads. */
export function useHtmlRenderTheme(): HtmlRenderTheme {
    const { currentTheme } = useThemeSystem();
    const interfaceSize = useUIStore((state) => state.fontSize);
    const isMobile = useUIStore((state) => state.isMobile);
    const { uiFont, monoFont, customUiFont, customMonoFont } = useFontPreferences();
    const [typography, setTypography] = React.useState(readTypography);

    React.useEffect(() => {
        // ThemeProvider writes size in a layout effect; the app root writes
        // families in a passive effect after its children. Read on the next
        // frame so both have committed, including on the initial mount.
        const frame = requestAnimationFrame(() => setTypography(readTypography()));
        return () => cancelAnimationFrame(frame);
    }, [currentTheme, interfaceSize, isMobile, uiFont, monoFont, customUiFont, customMonoFont]);

    return React.useMemo(() => htmlRenderTheme(currentTheme, typography), [currentTheme, typography]);
}
