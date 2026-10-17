import React from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { Theme } from '@/types/theme';
import { mixColor } from '@/lib/theme/color';

/**
 * True inside a panel docked beside the chat: the context panel card and the
 * work status card when it is not floating. Such a panel takes the sidebar's
 * colour instead of the chat's (halfway to it in light themes); CSS does that for everything
 * painted with `bg-background` or `var(--surface-background)` (the
 * `.oc-panel-edge` rule in design-system.css). Surfaces that take their
 * colour from the theme object instead (the terminal, extension frames) read
 * it through `usePageColors` so they match the panel they sit in.
 */
export const DockedPanelSurfaceContext = React.createContext(false);

type PageColors = {
  /** The colour of the page the surface sits on. */
  background: string;
  /** A soft block one step off that page, for extensions' muted surfaces. */
  mutedSurface: string;
};

const pageColorsFor = (theme: Theme, docked: boolean): PageColors => {
  const { surface } = theme.colors;
  if (!docked) return { background: surface.background, mutedSurface: surface.muted };
  // The docked panel is painted with the theme's muted surface (halfway to it
  // in light themes, as the CSS rule does), so a soft block inside it takes
  // the chat colour: a step the other way.
  const background = theme.metadata.variant === 'dark' ? surface.muted : mixColor(surface.muted, surface.background, 0.5);
  return { background, mutedSurface: surface.background };
};

export const usePageColors = (): PageColors => {
  const docked = React.useContext(DockedPanelSurfaceContext);
  const { currentTheme } = useThemeSystem();
  return React.useMemo(() => pageColorsFor(currentTheme, docked), [currentTheme, docked]);
};
