import type { GuestHostSurface, HostTheme } from '../contract.ts';

export type ThemeRoot = {
  style: {
    colorScheme: string;
    setProperty: (name: string, value: string) => void;
  };
  dataset?: {
    ocSurface?: string;
    ocTheme?: string;
  };
};

const TOKEN_VARS = [
  ['--oc-bg', 'background'],
  ['--oc-elevated', 'elevated'],
  ['--oc-fg', 'foreground'],
  ['--oc-muted', 'muted'],
  ['--oc-subtle', 'subtle'],
  ['--oc-border', 'border'],
  ['--oc-hover', 'hover'],
  ['--oc-selection', 'selection'],
  ['--oc-focus', 'focus'],
  ['--oc-primary', 'primary'],
  ['--oc-muted-surface', 'mutedSurface'],
  ['--oc-elevated-fg', 'elevatedForeground'],
  ['--oc-active', 'active'],
  ['--oc-selection-fg', 'selectionForeground'],
  ['--oc-primary-fg', 'primaryForeground'],
  ['--oc-success', 'success'],
  ['--oc-warning', 'warning'],
  ['--oc-error', 'error'],
  ['--oc-info', 'info'],
  ['--oc-font', 'font'],
  ['--oc-mono', 'mono'],
  ['--oc-radius', 'radius'],
  ['--surface-background', 'background'],
  ['--surface-elevated', 'elevated'],
  ['--surface-foreground', 'foreground'],
  ['--surface-muted-foreground', 'muted'],
  ['--surface-subtle', 'subtle'],
  ['--interactive-border', 'border'],
  ['--interactive-hover', 'hover'],
  ['--interactive-selection', 'selection'],
  ['--interactive-focus-ring', 'focus'],
  ['--primary', 'primary'],
  ['--surface-muted', 'mutedSurface'],
  ['--surface-elevated-foreground', 'elevatedForeground'],
  ['--interactive-active', 'active'],
  ['--interactive-selection-foreground', 'selectionForeground'],
  ['--primary-foreground', 'primaryForeground'],
  ['--status-success', 'success'],
  ['--status-warning', 'warning'],
  ['--status-error', 'error'],
  ['--status-info', 'info'],
  ['--font-sans', 'font'],
  ['--font-mono', 'mono'],
  ['--radius', 'radius'],
] as const;

/**
 * Paint the host theme onto the iframe root. Guest chrome reads these
 * variables, and the root itself gets the host font and text colour so plain
 * DOM the guest draws outside the kit (a `<pre>`, a `<p>`) inherits them
 * instead of the browser's serif default.
 */
export const applyHostTheme = (theme: HostTheme, root: ThemeRoot): void => {
  root.style.colorScheme = theme.mode;
  for (const [name, key] of TOKEN_VARS) {
    root.style.setProperty(name, theme.tokens[key]);
  }
  root.style.setProperty('font-family', theme.tokens.font);
  root.style.setProperty('font-size', '0.875rem');
  root.style.setProperty('line-height', '1.45');
  root.style.setProperty('color', theme.tokens.foreground);
};

export const applyHostReady = (
  ctx: { theme: HostTheme; surface: GuestHostSurface },
  root: ThemeRoot,
): void => {
  applyHostTheme(ctx.theme, root);
  if (root.dataset) {
    root.dataset.ocSurface = ctx.surface;
    root.dataset.ocTheme = ctx.theme.mode;
  }
};
