import React from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useUIStore } from '@/stores/useUIStore';
import { htmlRenderTheme, type HtmlRenderTheme } from './htmlRender';

const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_MONO = 'ui-monospace, "SFMono-Regular", Menlo, monospace';

/** Project the current app theme and interface typography into a sandbox page. */
export function useHtmlRenderTheme(): HtmlRenderTheme {
  const { currentTheme } = useThemeSystem();
  const interfaceSize = useUIStore((state) => state.fontSize);
  return React.useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const rem = Number.parseFloat(style.fontSize) || 16 * interfaceSize / 100;
    const text = (Number.parseFloat(style.getPropertyValue('--text-markdown')) || 0.875) * rem;
    return htmlRenderTheme(currentTheme, {
      rem,
      text,
      sans: style.getPropertyValue('--font-sans').trim() || DEFAULT_SANS,
      mono: style.getPropertyValue('--font-mono').trim() || DEFAULT_MONO,
    });
  }, [currentTheme, interfaceSize]);
}
