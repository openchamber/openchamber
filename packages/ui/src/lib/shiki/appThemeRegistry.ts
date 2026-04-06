import { registerCustomTheme } from '@pierre/diffs';

import type { Theme } from '@/types/theme';
import type { VSCodeTextMateTheme, VSCodeTokenColorRule } from './vscodeTextMateTheme';
import { buildTextMateThemeFromAppTheme } from './textMateThemeFromAppTheme';

export type ShikiThemeRegistrationResolvedLike = VSCodeTextMateTheme & {
  settings: VSCodeTokenColorRule[];
  fg: string;
  bg: string;
};

const isHex8 = (value: string): boolean => /^#[0-9a-fA-F]{8}$/.test(value);

const stripAlpha = (value: string): string => {
  if (isHex8(value)) {
    return value.slice(0, 7);
  }
  return value;
};

function withStableStringId<T extends object>(value: T, id: string): T {
  Object.defineProperty(value, 'toString', {
    value: () => id,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(value, Symbol.toPrimitive, {
    value: () => id,
    enumerable: false,
    configurable: true,
  });

  return value;
}

const resolvedThemeCache = new Map<string, ShikiThemeRegistrationResolvedLike>();
const registeredPierreThemes = new Set<string>();

const toResolvedTheme = (raw: VSCodeTextMateTheme, id: string): ShikiThemeRegistrationResolvedLike => {
  const bgRaw = raw.colors?.['editor.background'];
  const fgRaw = raw.colors?.['editor.foreground'];

  const bg = bgRaw ? stripAlpha(bgRaw) : undefined;
  const fg = fgRaw ? stripAlpha(fgRaw) : undefined;

  if (!bg || !fg) {
    throw new Error(`Theme "${id}" is missing editor.background/editor.foreground`);
  }

  const settings = raw.tokenColors ?? [];

  return withStableStringId(
    {
      ...raw,
      name: id,
      fg,
      bg,
      settings,
    },
    id,
  );
};

const buildTextMateTheme = (theme: Theme): VSCodeTextMateTheme => {
  return buildTextMateThemeFromAppTheme(theme);
};

export const getResolvedShikiTheme = (theme: Theme): ShikiThemeRegistrationResolvedLike => {
  const cached = resolvedThemeCache.get(theme.metadata.id);
  if (cached) {
    return cached;
  }

  const raw = buildTextMateTheme(theme);
  const resolved = toResolvedTheme(raw, theme.metadata.id);
  resolvedThemeCache.set(theme.metadata.id, resolved);
  return resolved;
};

export const ensurePierreThemeRegistered = (theme: Theme): void => {
  const id = theme.metadata.id;
  if (registeredPierreThemes.has(id)) {
    return;
  }

  const resolved = getResolvedShikiTheme(theme);
  registerCustomTheme(id, async () => resolved);
  registeredPierreThemes.add(id);
};
