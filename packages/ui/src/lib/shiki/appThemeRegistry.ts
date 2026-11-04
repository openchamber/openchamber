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
const registeredPierreThemeNames = new Set<string>();
const renderNames = new WeakMap<Theme, string>();

export const getThemeContentSignature = (theme: Theme): string => JSON.stringify(theme);

const digest = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/**
 * The name a theme is highlighted and registered under: its ID plus a digest
 * of its colours. @pierre/diffs ignores a second registration of a name, and
 * the highlighter workers and diff caches key on the name, so a custom theme
 * edited on disk keeps the same ID but must render under a new name.
 */
export const getThemeRenderName = (theme: Theme): string => {
  let name = renderNames.get(theme);
  if (!name) {
    name = `${theme.metadata.id}@${digest(getThemeContentSignature(theme))}`;
    renderNames.set(theme, name);
  }
  return name;
};

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
  const resolved = toResolvedTheme(raw, getThemeRenderName(theme));
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
    zed = { ...buildZedThemeFromAppTheme(theme), name: textmate.name };
    zedThemeCache.set(textmate, zed);
  }
  return { textmate, zed };
};

/** Registers the theme with @pierre/diffs once per content and returns the name to render it with. */
export const ensurePierreThemeRegistered = (theme: Theme): string => {
  const name = getThemeRenderName(theme);
  if (registeredPierreThemeNames.has(name)) {
    return name;
  }

  // One registration serves both highlighter backends: Shiki reads the
  // TextMate theme, Highlights the Zed one, and the diff chrome reads `colors`.
  const { textmate, zed } = getCodeTokenTheme(theme);
  const diffsTheme: DiffsTheme = {
    name,
    type: textmate.type,
    fg: textmate.fg,
    bg: textmate.bg,
    colors: textmate.colors,
    textmate,
    zed,
  };
  registerCustomTheme(name, async () => diffsTheme, 'diffs');
  registeredPierreThemeNames.add(name);
  return name;
};
