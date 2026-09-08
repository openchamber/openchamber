import type { Theme } from '@/types/theme';
import type { GhosttyColor, GhosttyTheme } from '@/lib/ghostty/core';

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export function convertThemeToXterm(theme: Theme): TerminalTheme {
  const { colors } = theme;
  const syntax = colors.syntax.base;

  return {

    background: colors.surface.background,
    foreground: syntax.foreground,
    cursor: colors.interactive.cursor,
    cursorAccent: colors.surface.background,

    selectionBackground: colors.interactive.selection,
    selectionForeground: colors.interactive.selectionForeground,
    selectionInactiveBackground: colors.interactive.selection + '50',

    black: colors.surface.muted,
    red: colors.status.error,
    green: colors.status.success,
    yellow: colors.status.warning,
    blue: syntax.function,
    magenta: syntax.keyword,
    cyan: syntax.type,
    white: syntax.foreground,

    brightBlack: syntax.comment,
    brightRed: colors.status.error,
    brightGreen: colors.status.success,
    brightYellow: colors.status.warning,
    brightBlue: syntax.function,
    brightMagenta: syntax.keyword,
    brightCyan: syntax.type,
    brightWhite: colors.surface.elevatedForeground,
  };
}

const ANSI_ORDER = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

/** Parses #rgb, #rrggbb (alpha digits ignored) or rgb()/rgba() into channels. */
const parseTerminalColor = (color: string): GhosttyColor | null => {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    const expanded = hex.length <= 4
      ? hex.slice(0, 3).split('').map((part) => part + part).join('')
      : hex.slice(0, 6);
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
    };
  }

  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+)?\s*\)$/i.exec(value);
  if (!rgb) return null;
  const [r, g, b] = rgb.slice(1, 4).map(Number);
  if ([r, g, b].some((channel) => channel === undefined || channel < 0 || channel > 255)) return null;
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
};

/**
 * Theme colors as libghostty-vt takes them. Theme JSON values are hex, so a
 * parse failure means a broken theme file: fall back to plain white on black
 * for that entry rather than sending Ghostty garbage.
 */
export function toGhosttyTheme(theme: TerminalTheme): GhosttyTheme {
  const background = parseTerminalColor(theme.background) ?? { r: 0, g: 0, b: 0 };
  const foreground = parseTerminalColor(theme.foreground) ?? { r: 255, g: 255, b: 255 };
  return {
    background,
    foreground,
    cursor: parseTerminalColor(theme.cursor) ?? foreground,
    palette: ANSI_ORDER.map((name) => parseTerminalColor(theme[name]) ?? foreground),
    selectionBackground: theme.selectionBackground,
  };
}
