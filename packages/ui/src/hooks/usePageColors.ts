import React from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { Theme } from '@/types/theme';
import { mixColor } from '@/lib/theme/color';

/**
 * True inside a panel docked beside the chat: the context panel card and the
 * work status card when it is not floating. Such a panel is one tile step off
 * the chat's colour (the text colour mixed in); CSS does that for everything
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
  // The docked panel is the chat's colour with the text colour mixed in at
  // the panel step (--oc-panel-tone: 3% dark, 6% light), as the CSS rule does,
  // so a soft block inside it takes the chat colour: a step the other way.
  const background = mixColor(surface.foreground, surface.background, theme.metadata.variant === 'dark' ? 0.03 : 0.06);
  return { background, mutedSurface: surface.background };
};

export const usePageColors = (): PageColors => {
  const docked = React.useContext(DockedPanelSurfaceContext);
  const { currentTheme } = useThemeSystem();
  return React.useMemo(() => pageColorsFor(currentTheme, docked), [currentTheme, docked]);
};
