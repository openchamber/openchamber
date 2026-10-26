import { registerCustomTheme, type DiffsTheme } from '@pierre/diffs';
import type { Theme as ZedTheme } from '@pierre/highlights';

import type { Theme } from '@/types/theme';
import type { VSCodeTextMateTheme, VSCodeTokenColorRule } from './vscodeTextMateTheme';
import { buildTextMateThemeFromAppTheme } from './textMateThemeFromAppTheme';
import { buildZedThemeFromAppTheme } from './zedThemeFromAppTheme';

type ShikiThemeRegistrationResolvedLike = VSCodeTextMateTheme & {
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

const MAX_RESOLVED_THEME_CACHE_ENTRIES = 40;
const resolvedThemeCache = new Map<string, ShikiThemeRegistrationResolvedLike>();
// Keyed by the cached TextMate theme, so both formats share its lifetime.
const zedThemeCache = new WeakMap<ShikiThemeRegistrationResolvedLike, ZedTheme>();
const registeredPierreThemeSignatures = new Map<string, string>();

export const getThemeContentSignature = (theme: Theme): string => JSON.stringify(theme);

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
  const signature = getThemeContentSignature(theme);
  const cached = resolvedThemeCache.get(signature);
  if (cached) {
    resolvedThemeCache.delete(signature);
    resolvedThemeCache.set(signature, cached);
    return cached;
  }

  const raw = buildTextMateTheme(theme);
  const resolved = toResolvedTheme(raw, theme.metadata.id);
  resolvedThemeCache.set(signature, resolved);
  while (resolvedThemeCache.size > MAX_RESOLVED_THEME_CACHE_ENTRIES) {
    const oldest = resolvedThemeCache.keys().next().value;
    if (oldest === undefined) break;
    resolvedThemeCache.delete(oldest);
  }
  return resolved;
};

/** The app theme for both highlighters: Shiki reads `textmate`, Highlights `zed`. */
export const getCodeTokenTheme = (theme: Theme) => {
  const textmate = getResolvedShikiTheme(theme);
  let zed = zedThemeCache.get(textmate);
  if (!zed) {
    zed = buildZedThemeFromAppTheme(theme);
    zedThemeCache.set(textmate, zed);
  }
  return { textmate, zed };
};

export const ensurePierreThemeRegistered = (theme: Theme): void => {
  const id = theme.metadata.id;
  const signature = getThemeContentSignature(theme);
  if (registeredPierreThemeSignatures.get(id) === signature) {
    return;
  }

  // One registration serves both highlighter backends: Shiki reads the
  // TextMate theme, Highlights the Zed one, and the diff chrome reads `colors`.
  const { textmate, zed } = getCodeTokenTheme(theme);
  const diffsTheme: DiffsTheme = {
    name: id,
    type: textmate.type,
    fg: textmate.fg,
    bg: textmate.bg,
    colors: textmate.colors,
    textmate,
    zed,
  };
  registerCustomTheme(id, async () => diffsTheme, 'diffs');
  registeredPierreThemeSignatures.set(id, signature);
};
