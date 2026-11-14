import React from 'react';

import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useUIStore } from '@/stores/useUIStore';

const HOST_FONT_FALLBACK = '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const HOST_MONO_FALLBACK = 'ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace';

export type HostTypography = {
  font: string;
  mono: string;
  /** The app's body text in pixels, which the frame takes as its 1rem. */
  fontSize: string;
};

const readHostTypography = (): HostTypography => {
  const style = getComputedStyle(document.documentElement);
  const rem = Number.parseFloat(style.fontSize) || 16;
  // Body text is authored in rem (0.875, and 1 on phones); the interface
  // font size scales the root rem under it.
  const text = (Number.parseFloat(style.getPropertyValue('--text-markdown')) || 0.875) * rem;
  return {
    font: style.getPropertyValue('--font-sans').trim() || HOST_FONT_FALLBACK,
    mono: style.getPropertyValue('--font-mono').trim() || HOST_MONO_FALLBACK,
    fontSize: `${Math.round(text * 100) / 100}px`,
  };
};

const sameTypography = (a: HostTypography, b: HostTypography) => (
  a.font === b.font && a.mono === b.mono && a.fontSize === b.fontSize
);

/** The app's fonts and text size for guest frames, following the user's settings live. */
export function useHostTypography(): HostTypography {
  const interfaceSize = useUIStore((state) => state.fontSize);
  const { uiFont, monoFont, customUiFont, customMonoFont } = useFontPreferences();
  const [typography, setTypography] = React.useState(readHostTypography);
  // The settings reach the root in layout effects (ThemeProvider,
  // useAppFontEffects), and a passive effect runs after all of them, so it
  // reads the new values.
  React.useEffect(() => {
    const next = readHostTypography();
    setTypography((current) => (sameTypography(current, next) ? current : next));
  }, [interfaceSize, uiFont, monoFont, customUiFont, customMonoFont]);
  return typography;
}
