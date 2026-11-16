import React from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { Theme } from '@/types/theme';
import { mixColor } from '@/lib/theme/color';

export const DockedPanelSurfaceContext = React.createContext(false);

type PageColors = {
  background: string;
  mutedSurface: string;
};

const pageColorsFor = (theme: Theme, docked: boolean): PageColors => {
  const { surface } = theme.colors;
  if (!docked) return { background: surface.background, mutedSurface: surface.muted };
  const background = theme.metadata.variant === 'dark' ? surface.muted : mixColor(surface.muted, surface.background, 0.5);
  return { background, mutedSurface: surface.background };
};

export const usePageColors = (): PageColors => {
  const docked = React.useContext(DockedPanelSurfaceContext);
  const { currentTheme } = useThemeSystem();
  return React.useMemo(() => pageColorsFor(currentTheme, docked), [currentTheme, docked]);
};
