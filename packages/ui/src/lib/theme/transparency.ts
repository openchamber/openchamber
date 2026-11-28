import type { Theme } from '@/types/theme';
import { opaqueColor, toHexColor, withOpacity } from './color';

const BACKGROUNDS = new Set([
  'surface.background', 'surface.muted', 'surface.elevated', 'surface.overlay', 'surface.subtle',
  'primary.hover', 'primary.active', 'primary.muted',
  'interactive.hover', 'interactive.active', 'interactive.selection',
]);

export const isThemeBackground = (path: string): boolean =>
  BACKGROUNDS.has(path) || path.endsWith('.background') || path.endsWith('Background');

const scaleOpacity = (value: string, opacity: number): string => {
  const hex = toHexColor(value);
  if (!hex) return `color-mix(in srgb, ${value} ${opacity * 100}%, transparent)`;
  const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
  return withOpacity(hex, alpha * opacity);
};

export function windowSurfaceColors(theme: Theme, opacity: number) {
  const { surface } = theme.colors;
  return {
    background: scaleOpacity(surface.background, opacity),
    muted: scaleOpacity(surface.muted, opacity === 1 ? 1 : opacity / 2),
    elevated: scaleOpacity(surface.elevated, 0.1 + 0.9 * opacity),
  };
}

export function hasWindowSurfaceAlpha(theme: Theme): boolean {
  const { background, muted, elevated } = theme.colors.surface;
  return [background, muted, elevated].some((value) => {
    const hex = toHexColor(value);
    return !hex || hex.length === 9 && parseInt(hex.slice(7), 16) < 255;
  });
}

export function translucentWindowCSS(theme: Theme, opacity: number): string {
  const { surface } = theme.colors;
  const colors = windowSurfaceColors(theme, opacity);
  return `

:root:root.desktop-runtime {
  background: transparent !important;
}

@layer base {
  :root:root.desktop-runtime body {
    background: transparent !important;
  }
}

:root {
  --oc-text-backdrop: ${opaqueColor(surface.background)};
}

#root {
  --background: ${colors.background};
  --surface-elevated: ${colors.elevated};
}

#root .oc-glass-popover,
#root .oc-glass-tooltip {
  --surface-elevated: ${surface.elevated};
}

#root > *,
#root .oc-panel-edge > * {
  --background: transparent;
  --surface-background: transparent;
}

#root > * {
  --sidebar: ${colors.muted};
}

#root [data-sidebar-peek] {
  --sidebar: ${surface.muted};
}

#root .oc-panel-edge:not([data-edge-floating]) {
  --background: ${colors.muted};
  --surface-background: ${colors.muted};
}`;
}
