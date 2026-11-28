import type { Theme } from '@/types/theme';
import { compactThemeDraft, requireTheme, requireThemeDraft } from './definition';
import { opaqueColor, toHexColor, withOpacity } from './color';
import { isThemeBackground } from './transparency';
import { MAX_THEME_IMPORT_BYTES, ThemeImportError } from './importErrors';

type ColorBranches<T> = T extends string | undefined ? never : T | ColorBranches<T[keyof T]>;
type ColorTree = { [key: string]: string | ColorBranches<Theme['colors']> | ColorTree | undefined };
type ColorNode = ColorBranches<Theme['colors']> | ColorTree;

export function themeColorFields(colors: ColorNode, prefix = ''): Array<{ path: string; value: string; background: boolean }> {
  return Object.entries(colors).flatMap(([key, value]: [string, string | ColorNode | undefined]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') return [{ path, value, background: isThemeBackground(path) }];
    return value && typeof value === 'object' ? themeColorFields(value, path) : [];
  });
}
function mapColors(colors: ColorNode, transform: (value: string, path: string) => string, prefix = ''): ColorTree {
  return Object.fromEntries(Object.entries(colors).map(([key, value]: [string, string | ColorNode | undefined]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [key, typeof value === 'string' ? transform(value, path)
      : value && typeof value === 'object' ? mapColors(value, transform, path) : value];
  }));
}

function literalColor(value: string): string {
  const hex = toHexColor(value);
  if (hex) return hex;
  if (typeof document === 'undefined' || !CSS.supports('color', value)) throw new ThemeImportError('invalid');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) throw new ThemeImportError('invalid');
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return '#' + Array.from(context.getImageData(0, 0, 1, 1).data).map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

export function editorTheme(theme: Theme): Theme {
  return requireTheme({
    ...theme,
    colors: mapColors(theme.colors, literalColor),
  });
}

function writeColor(colors: ColorNode, keys: string[], value: string): void {
  const [key, ...rest] = keys;
  if (!key) throw new ThemeImportError('invalid');
  if (!rest.length) { Object.assign(colors, { [key]: value }); return; }
  const child: string | ColorNode | undefined = Object.entries(colors).find(([candidate]) => candidate === key)?.[1];
  if (typeof child === 'string') throw new ThemeImportError('invalid');
  const branch = child ?? {};
  Object.assign(colors, { [key]: branch });
  writeColor(branch, rest, value);
}

export function changeThemeColor(theme: Theme, path: string, value: string): Theme {
  const field = themeColorFields(theme.colors).find((item) => item.path === path);
  if (!field) throw new ThemeImportError('invalid');
  const hex = toHexColor(value);
  if (!hex) throw new ThemeImportError('invalid');
  const opacity = colorOpacity(field.value);
  const color = field.background ? hex : opacity < 1 ? withOpacity(hex, opacity) : opaqueColor(hex);
  const source = compactThemeDraft(theme);
  writeColor(source.colors, path.split('.'), color);
  return requireThemeDraft(source);
}

export function colorOpacity(value: string): number {
  const hex = toHexColor(value);
  if (!hex) throw new ThemeImportError('invalid');
  return hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
}

export function changeBackgroundOpacity(theme: Theme, path: string, opacity: number): Theme {
  if (!isThemeBackground(path) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new ThemeImportError('invalid');
  const field = themeColorFields(theme.colors).find((item) => item.path === path);
  if (!field) throw new ThemeImportError('invalid');
  return changeThemeColor(theme, path, withOpacity(field.value, opacity));
}

export function parseEditorTheme(text: string): Theme {
  if (new TextEncoder().encode(text).byteLength > MAX_THEME_IMPORT_BYTES) throw new ThemeImportError('size');
  try { return editorTheme(requireTheme(JSON.parse(text.replace(/^\uFEFF/, '')))); }
  catch (error) {
    if (error instanceof ThemeImportError) throw error;
    throw new ThemeImportError('invalid');
  }
}
