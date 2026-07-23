#!/usr/bin/env tsx

/*
 * Port OpenCode themes into full OpenChamber theme JSON files.
 *
 * Usage:
 *   bun run themes:port:opencode --list
 *   bun run themes:port:opencode github cursor lucent-orng --force
 *   bun run themes:port:opencode aura --out-dir /tmp/openchamber-theme-port-test --force
 *   bun run themes:port:opencode path/to/theme.json --stdout
 *
 * Expected result:
 *   - resolves theme colors from OpenCode desktop themes, TUI context themes,
 *     or existing OpenChamber theme JSON files
 *   - writes complete OpenChamber light/dark theme JSON output with solid core
 *     surfaces, interactive colors, syntax colors, and full schema coverage
 *   - produces files ready to register in presets without half-mapped tokens
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type ColorValue = string;

interface ThemePaletteColors {
  neutral: string;
  ink?: string;
  primary: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  accent?: string;
  interactive?: string;
  diffAdd?: string;
  diffDelete?: string;
}

interface ThemeSeedColors {
  neutral: string;
  primary: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  interactive: string;
  diffAdd: string;
  diffDelete: string;
}

type ThemeVariant =
  | { palette: ThemePaletteColors; seeds?: never; overrides?: Record<string, string> }
  | { seeds: ThemeSeedColors; palette?: never; overrides?: Record<string, string> };

interface DesktopTheme {
  name: string;
  id: string;
  light: ThemeVariant;
  dark: ThemeVariant;
}

interface OpenChamberTheme {
  metadata: {
    id: string;
    name: string;
    description: string;
    author?: string;
    version: string;
    variant: 'light' | 'dark';
    tags: string[];
  };
  colors: Record<string, unknown>;
  config: Record<string, unknown>;
}

type ContextThemeMode = 'light' | 'dark';

type ContextThemeColorRef = string | { dark: string; light: string };

interface ContextThemeJson {
  $schema?: string;
  defs?: Record<string, string>;
  theme: Record<string, ContextThemeColorRef | number>;
}

type ResolvedContextTheme = Record<string, string> & {
  thinkingOpacity?: number;
};

type ThemeSource = DesktopTheme | ContextThemeJson | OpenChamberTheme;

type ResolvedTheme = Record<string, ColorValue>;

type ParsedArgs = {
  opencodeRoot: string;
  outDir: string;
  force: boolean;
  stdout: boolean;
  list: boolean;
  specs: string[];
};

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_OPENCODE_ROOT = path.join(os.homedir(), 'projects', 'opencode');
const DEFAULT_DESKTOP_SOURCE_DIR = path.join(DEFAULT_OPENCODE_ROOT, 'packages', 'ui', 'src', 'theme', 'themes');
const DEFAULT_CONTEXT_SOURCE_DIR = path.join(
  DEFAULT_OPENCODE_ROOT,
  'packages',
  'opencode',
  'src',
  'cli',
  'cmd',
  'tui',
  'context',
  'theme',
);
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'packages', 'ui', 'src', 'lib', 'theme', 'themes');

const DEFAULT_CONFIG = {
  fonts: {
    sans: '"IBM Plex Mono", monospace',
    mono: '"IBM Plex Mono", monospace',
    heading: '"IBM Plex Mono", monospace',
  },
  radius: {
    none: '0',
    sm: '0.125rem',
    md: '0.375rem',
    lg: '0.5rem',
    xl: '0.75rem',
    full: '9999px',
  },
  spacing: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '0.75rem',
    lg: '1rem',
    xl: '1.5rem',
  },
  transitions: {
    fast: '150ms ease',
    normal: '250ms ease',
    slow: '350ms ease',
  },
};

const usage = () => {
  console.error(
    [
      'Usage: tsx scripts/port-opencode-theme.ts [options] <theme-id|path> [...more]',
      '',
      'Options:',
      '  --opencode-root <path>  OpenCode repo root (default: ~/projects/opencode)',
      '  --out-dir <path>        Output directory (default: packages/ui/src/lib/theme/themes)',
      '  --stdout                Print generated JSON instead of writing files',
      '  --force                 Overwrite existing files',
      '  --list                  List available OpenCode themes',
    ].join('\n'),
  );
};

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    opencodeRoot: DEFAULT_OPENCODE_ROOT,
    outDir: DEFAULT_OUT_DIR,
    force: false,
    stdout: false,
    list: false,
    specs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === '--opencode-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --opencode-root');
      args.opencodeRoot = expandHome(value);
      index += 1;
      continue;
    }

    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --out-dir');
      args.outDir = path.resolve(expandHome(value));
      index += 1;
      continue;
    }

    if (arg === '--force') {
      args.force = true;
      continue;
    }

    if (arg === '--stdout') {
      args.stdout = true;
      continue;
    }

    if (arg === '--list') {
      args.list = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    args.specs.push(arg);
  }

  return args;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listThemes(opencodeRoot: string): Promise<void> {
  const sourceDirs = [
    path.join(opencodeRoot, 'packages', 'ui', 'src', 'theme', 'themes'),
    path.join(opencodeRoot, 'packages', 'opencode', 'src', 'cli', 'cmd', 'tui', 'context', 'theme'),
  ];

  const names = new Set<string>();
  for (const sourceDir of sourceDirs) {
    if (!(await exists(sourceDir))) continue;
    const entries = await fs.readdir(sourceDir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      names.add(entry.replace(/\.json$/u, ''));
    }
  }

  for (const entry of Array.from(names).sort((left, right) => left.localeCompare(right))) {
    console.log(entry);
  }
}

async function resolveThemeSpec(spec: string, opencodeRoot: string): Promise<string> {
  const expanded = expandHome(spec);
  const asAbsolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  if (await exists(asAbsolute)) {
    return asAbsolute;
  }

  const sourceDirs = [
    path.join(opencodeRoot, 'packages', 'ui', 'src', 'theme', 'themes'),
    path.join(opencodeRoot, 'packages', 'opencode', 'src', 'cli', 'cmd', 'tui', 'context', 'theme'),
  ];

  for (const sourceDir of sourceDirs) {
    const themedPath = path.join(sourceDir, spec.endsWith('.json') ? spec : `${spec}.json`);
    if (await exists(themedPath)) {
      return themedPath;
    }
  }

  throw new Error(`Theme not found: ${spec}`);
}

async function loadThemeSource(themePath: string): Promise<ThemeSource> {
  const raw = await fs.readFile(themePath, 'utf8');
  return JSON.parse(raw) as ThemeSource;
}

function isDesktopTheme(value: ThemeSource): value is DesktopTheme {
  return Boolean(value && typeof value === 'object' && 'light' in value && 'dark' in value && 'id' in value && 'name' in value);
}

function isContextTheme(value: ThemeSource): value is ContextThemeJson {
  return Boolean(value && typeof value === 'object' && 'theme' in value && !('light' in value) && !('metadata' in value));
}

function isOpenChamberTheme(value: ThemeSource): value is OpenChamberTheme {
  return Boolean(value && typeof value === 'object' && 'metadata' in value && 'colors' in value);
}

async function loadResolver(opencodeRoot: string): Promise<(variant: ThemeVariant, isDark: boolean) => ResolvedTheme> {
  const resolvePath = path.join(opencodeRoot, 'packages', 'ui', 'src', 'theme', 'resolve.ts');
  if (!(await exists(resolvePath))) {
    throw new Error(`OpenCode resolver not found: ${resolvePath}`);
  }

  const mod = await import(pathToFileURL(resolvePath).href);
  if (typeof mod.resolveThemeVariant !== 'function') {
    throw new Error(`resolveThemeVariant export missing in ${resolvePath}`);
  }

  return mod.resolveThemeVariant as (variant: ThemeVariant, isDark: boolean) => ResolvedTheme;
}

function sourceVariantColor(variant: ThemeVariant, key: keyof ThemePaletteColors | keyof ThemeSeedColors): string | undefined {
  if (variant.palette) {
    return variant.palette[key as keyof ThemePaletteColors];
  }
  if (variant.seeds) {
    return variant.seeds[key as keyof ThemeSeedColors];
  }
  return undefined;
}

function sourceThemeName(themePath: string): string {
  const base = path.basename(themePath, '.json');
  const knownNames: Record<string, string> = {
    github: 'GitHub',
    rosepine: 'Rose Pine',
    amoled: 'AMOLED',
    'oc-2': 'OC-2',
  };
  if (knownNames[base]) {
    return knownNames[base];
  }
  return base
    .split(/[-_]+/u)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function sourceThemeId(themePath: string): string {
  return path.basename(themePath, '.json');
}

function resolveContextValue(
  theme: ContextThemeJson,
  value: ContextThemeColorRef | number,
  mode: ContextThemeMode,
  seen: Set<string> = new Set(),
): string {
  if (typeof value === 'number') {
    return '#000000';
  }

  if (typeof value === 'object') {
    return resolveContextValue(theme, value[mode], mode, seen);
  }

  const normalized = value.trim();
  if (normalized === 'transparent' || normalized === 'none') {
    return '#00000000';
  }
  if (normalized.startsWith('#') || normalized.startsWith('rgb')) {
    return normalized;
  }

  if (seen.has(normalized)) {
    throw new Error(`Circular theme reference: ${normalized}`);
  }

  const defs = theme.defs ?? {};
  if (defs[normalized] !== undefined) {
    seen.add(normalized);
    return resolveContextValue(theme, defs[normalized], mode, seen);
  }

  const themeValue = theme.theme[normalized];
  if (themeValue !== undefined) {
    seen.add(normalized);
    return resolveContextValue(theme, themeValue, mode, seen);
  }

  throw new Error(`Unknown context theme reference: ${normalized}`);
}

function resolveContextTheme(theme: ContextThemeJson, mode: ContextThemeMode): ResolvedContextTheme {
  const resolved: ResolvedContextTheme = {};

  for (const [key, value] of Object.entries(theme.theme)) {
    if (key === 'thinkingOpacity') {
      if (typeof value === 'number') {
        resolved.thinkingOpacity = value;
      }
      continue;
    }

    resolved[key] = resolveContextValue(theme, value, mode);
  }

  return resolved;
}

function syntheticVariantFromResolvedTheme(source: {
  primary: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  accent: string;
  interactive: string;
  diffAdd: string;
  diffDelete: string;
  neutral: string;
  ink?: string;
}): ThemeVariant {
  return {
    palette: {
      neutral: source.neutral,
      ink: source.ink,
      primary: source.primary,
      success: source.success,
      warning: source.warning,
      error: source.error,
      info: source.info,
      accent: source.accent,
      interactive: source.interactive,
      diffAdd: source.diffAdd,
      diffDelete: source.diffDelete,
    },
  };
}

function syntheticTokensFromContextTheme(resolved: ResolvedContextTheme, mode: ContextThemeMode): ResolvedTheme {
  const isDark = mode === 'dark';
  const primary = resolved.primary ?? resolved.accent ?? resolved.info ?? resolved.borderActive ?? '#5A96BC';
  const warning = resolved.warning ?? '#DA702C';
  const error = resolved.error ?? '#AF3029';
  const success = resolved.success ?? '#66800B';
  const info = resolved.info ?? resolved.secondary ?? primary;
  const borderActive = resolved.borderActive ?? primary;
  const selection = withAlpha(primary, isDark ? 0.24 : 0.14);
  const baseBackground = firstVisibleColor(
    resolved.background,
    resolved.backgroundPanel,
    resolved.backgroundElement,
    resolved.backgroundMenu,
    isDark ? '#151313' : '#FFFCF0',
  )!;
  const panelBackground = firstVisibleColor(
    resolved.backgroundPanel,
    resolved.backgroundMenu,
    resolved.backgroundElement,
    resolved.background,
    baseBackground,
  )!;
  const elementBackground = firstVisibleColor(
    resolved.backgroundElement,
    resolved.backgroundMenu,
    resolved.backgroundPanel,
    resolved.background,
    panelBackground,
  )!;
  const menuBackground = firstVisibleColor(
    resolved.backgroundMenu,
    resolved.backgroundElement,
    resolved.backgroundPanel,
    resolved.background,
    elementBackground,
  )!;
  const hover = firstVisibleColor(
    resolved.backgroundElement,
    resolved.backgroundPanel,
    resolved.backgroundMenu,
    resolved.background,
    elementBackground,
  )!;
  const subtleBorder = resolved.borderSubtle ?? resolved.border ?? withAlpha(resolved.textMuted ?? resolved.text ?? '#000000', 0.2);
  const diffAddedBackground = firstVisibleColor(resolved.diffAddedBg, withAlpha(success, isDark ? 0.16 : 0.12))!;
  const diffRemovedBackground = firstVisibleColor(resolved.diffRemovedBg, withAlpha(error, isDark ? 0.16 : 0.12))!;
  const diffContextBackground = firstVisibleColor(resolved.diffContextBg, withAlpha(info, isDark ? 0.1 : 0.08))!;

  return {
    'background-base': baseBackground,
    'background-weak': panelBackground,
    'surface-weak': panelBackground,
    'surface-raised-base': menuBackground,
    'surface-raised-base-hover': menuBackground,
    'surface-raised-base-active': menuBackground,
    'surface-base': elementBackground,
    'surface-base-hover': hover,
    'surface-base-active': hover,
    'surface-strong': menuBackground,
    'surface-brand-hover': primary,
    'surface-interactive-weak': selection,
    'surface-inset-base': panelBackground,
    'surface-success-weak': diffAddedBackground,
    'surface-warning-weak': withAlpha(warning, isDark ? 0.16 : 0.12),
    'surface-critical-weak': diffRemovedBackground,
    'surface-critical-base': firstVisibleColor(resolved.diffRemovedBg, withAlpha(error, isDark ? 0.22 : 0.16))!,
    'surface-info-weak': withAlpha(info, isDark ? 0.16 : 0.12),
    'surface-diff-add-weak': diffAddedBackground,
    'surface-diff-delete-weak': diffRemovedBackground,
    'surface-diff-hidden-weak': diffContextBackground,
    'border-base': resolved.border ?? subtleBorder,
    'border-hover': subtleBorder,
    'border-focus': borderActive,
    'border-interactive-selected': borderActive,
    'border-weak-base': subtleBorder,
    'border-weak-hover': resolved.border ?? subtleBorder,
    'border-weaker-base': subtleBorder,
    'border-success-base': resolved.diffAdded ?? success,
    'border-warning-base': warning,
    'border-critical-base': resolved.diffRemoved ?? error,
    'border-critical-selected': error,
    'border-info-base': info,
    'text-base': resolved.text ?? '#CECDC3',
    'text-weak': resolved.textMuted ?? resolved.text ?? '#878580',
    'text-weaker': resolved.diffContext ?? resolved.textMuted ?? resolved.text ?? '#878580',
    'text-strong': resolved.text ?? '#CECDC3',
    'text-on-brand-base': accessibleForeground(primary),
    'text-on-success-base': accessibleForeground(success),
    'text-on-warning-base': accessibleForeground(warning),
    'text-on-critical-base': accessibleForeground(error),
    'text-on-info-base': accessibleForeground(info),
    'text-interactive-base': resolved.markdownLink ?? primary,
    'icon-success-base': success,
    'icon-warning-base': warning,
    'icon-critical-base': error,
    'icon-info-base': info,
    'icon-base': resolved.textMuted ?? resolved.text ?? '#878580',
    'icon-weak-base': resolved.textMuted ?? resolved.text ?? '#878580',
    'icon-diff-modified-base': resolved.diffHunkHeader ?? warning,
    'input-base': menuBackground,
    'input-selected': selection,
    'input-disabled': panelBackground,
    'button-ghost-hover': hover,
    'button-ghost-hover2': hover,
    'syntax-comment': resolved.syntaxComment ?? resolved.textMuted ?? '#878580',
    'syntax-keyword': resolved.syntaxKeyword ?? resolved.primary ?? primary,
    'syntax-string': resolved.syntaxString ?? resolved.success ?? success,
    'syntax-property': resolved.syntaxFunction ?? resolved.primary ?? primary,
    'syntax-variable': resolved.syntaxVariable ?? resolved.text ?? '#CECDC3',
    'syntax-type': resolved.syntaxType ?? resolved.warning ?? warning,
    'syntax-operator': resolved.syntaxOperator ?? resolved.text ?? '#CECDC3',
    'syntax-regexp': resolved.syntaxString ?? resolved.success ?? success,
    'syntax-punctuation': resolved.syntaxPunctuation ?? resolved.textMuted ?? '#878580',
    'syntax-constant': resolved.syntaxNumber ?? resolved.info ?? info,
    'syntax-diff-add': resolved.diffHighlightAdded ?? resolved.diffAdded ?? success,
    'syntax-diff-delete': resolved.diffHighlightRemoved ?? resolved.diffRemoved ?? error,
  };
}

function syntheticTokensFromOpenChamberTheme(theme: OpenChamberTheme): ResolvedTheme {
  const colors = theme.colors as Record<string, any>;
  const primary = colors.primary ?? {};
  const surface = colors.surface ?? {};
  const interactive = colors.interactive ?? {};
  const status = colors.status ?? {};
  const syntax = colors.syntax ?? { base: {}, tokens: {}, highlights: {} };

  return {
    'background-base': surface.background ?? '#151313',
    'background-weak': surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-weak': surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-raised-base': surface.elevated ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-raised-base-hover': interactive.hover ?? surface.elevated ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-raised-base-active': interactive.active ?? interactive.hover ?? surface.elevated ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-base': surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-base-hover': interactive.hover ?? surface.elevated ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-base-active': interactive.active ?? interactive.hover ?? surface.elevated ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-strong': surface.elevated ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-brand-hover': primary.hover ?? primary.base ?? '#5A96BC',
    'surface-interactive-weak': interactive.selection ?? withAlpha(primary.base ?? '#5A96BC', 0.16),
    'surface-inset-base': surface.elevated ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'surface-success-weak': status.successBackground ?? withAlpha(status.success ?? '#66800B', 0.12),
    'surface-warning-weak': status.warningBackground ?? withAlpha(status.warning ?? '#DA702C', 0.12),
    'surface-critical-weak': status.errorBackground ?? withAlpha(status.error ?? '#AF3029', 0.12),
    'surface-critical-base': status.errorBackground ?? withAlpha(status.error ?? '#AF3029', 0.16),
    'surface-info-weak': status.infoBackground ?? withAlpha(status.info ?? '#205EA6', 0.12),
    'surface-diff-add-weak': syntax.highlights?.diffAddedBackground ?? status.successBackground ?? withAlpha(status.success ?? '#66800B', 0.12),
    'surface-diff-delete-weak': syntax.highlights?.diffRemovedBackground ?? status.errorBackground ?? withAlpha(status.error ?? '#AF3029', 0.12),
    'surface-diff-hidden-weak': syntax.highlights?.diffModifiedBackground ?? status.infoBackground ?? withAlpha(status.info ?? '#205EA6', 0.12),
    'border-base': interactive.border ?? '#343331',
    'border-hover': interactive.borderHover ?? interactive.border ?? '#343331',
    'border-focus': interactive.borderFocus ?? interactive.focus ?? primary.base ?? '#5A96BC',
    'border-interactive-selected': interactive.borderFocus ?? interactive.focus ?? primary.base ?? '#5A96BC',
    'border-weak-base': interactive.border ?? '#343331',
    'border-weak-hover': interactive.borderHover ?? interactive.border ?? '#343331',
    'border-weaker-base': interactive.border ?? '#343331',
    'border-success-base': status.successBorder ?? status.success ?? '#66800B',
    'border-warning-base': status.warningBorder ?? status.warning ?? '#DA702C',
    'border-critical-base': status.errorBorder ?? status.error ?? '#AF3029',
    'border-critical-selected': status.error ?? '#AF3029',
    'border-info-base': status.infoBorder ?? status.info ?? '#205EA6',
    'text-base': surface.foreground ?? '#CECDC3',
    'text-weak': surface.mutedForeground ?? surface.foreground ?? '#878580',
    'text-weaker': surface.mutedForeground ?? surface.foreground ?? '#878580',
    'text-strong': surface.foreground ?? '#CECDC3',
    'text-on-brand-base': primary.foreground ?? accessibleForeground(primary.base ?? '#5A96BC'),
    'text-on-success-base': status.successForeground ?? accessibleForeground(status.success ?? '#66800B'),
    'text-on-warning-base': status.warningForeground ?? accessibleForeground(status.warning ?? '#DA702C'),
    'text-on-critical-base': status.errorForeground ?? accessibleForeground(status.error ?? '#AF3029'),
    'text-on-info-base': status.infoForeground ?? accessibleForeground(status.info ?? '#205EA6'),
    'text-interactive-base': colors.markdown?.link ?? primary.base ?? '#5A96BC',
    'icon-success-base': status.success ?? '#66800B',
    'icon-warning-base': status.warning ?? '#DA702C',
    'icon-critical-base': status.error ?? '#AF3029',
    'icon-info-base': status.info ?? '#205EA6',
    'icon-base': surface.mutedForeground ?? surface.foreground ?? '#878580',
    'icon-weak-base': surface.mutedForeground ?? surface.foreground ?? '#878580',
    'icon-diff-modified-base': syntax.highlights?.diffModified ?? status.warning ?? '#DA702C',
    'input-base': surface.elevated ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'input-selected': interactive.selection ?? withAlpha(primary.base ?? '#5A96BC', 0.16),
    'input-disabled': surface.muted ?? surface.background ?? '#1C1B1A',
    'button-ghost-hover': interactive.hover ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'button-ghost-hover2': interactive.active ?? interactive.hover ?? surface.muted ?? surface.background ?? '#1C1B1A',
    'syntax-comment': syntax.base?.comment ?? surface.mutedForeground ?? '#878580',
    'syntax-keyword': syntax.base?.keyword ?? primary.base ?? '#5A96BC',
    'syntax-string': syntax.base?.string ?? status.success ?? '#66800B',
    'syntax-property': syntax.tokens?.functionCall ?? syntax.base?.function ?? primary.base ?? '#5A96BC',
    'syntax-variable': syntax.base?.variable ?? surface.foreground ?? '#CECDC3',
    'syntax-type': syntax.base?.type ?? status.warning ?? '#DA702C',
    'syntax-operator': syntax.base?.operator ?? surface.foreground ?? '#CECDC3',
    'syntax-regexp': syntax.tokens?.regex ?? syntax.base?.string ?? status.success ?? '#66800B',
    'syntax-punctuation': syntax.tokens?.punctuation ?? surface.mutedForeground ?? '#878580',
    'syntax-constant': syntax.base?.number ?? status.info ?? '#205EA6',
    'syntax-diff-add': syntax.highlights?.diffAdded ?? status.success ?? '#66800B',
    'syntax-diff-delete': syntax.highlights?.diffRemoved ?? status.error ?? '#AF3029',
  };
}

function formatOpacity(opacity: number): string {
  return opacity.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '');
}

function withAlpha(color: string, opacity: number): string {
  const value = color.trim();
  const alpha = Math.max(0, Math.min(1, opacity));
  const hex = value.replace(/^#/u, '');

  if (/^[0-9a-f]{3}$/iu.test(hex)) {
    const expanded = hex
      .split('')
      .map((part) => `${part}${part}`)
      .join('');
    const alphaHex = Math.round(alpha * 255).toString(16).padStart(2, '0');
    return `#${expanded}${alphaHex}`;
  }

  if (/^[0-9a-f]{6}$/iu.test(hex)) {
    const alphaHex = Math.round(alpha * 255).toString(16).padStart(2, '0');
    return `#${hex}${alphaHex}`;
  }

  const rgb = value.match(
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*[0-9.]+)?\s*\)$/iu,
  );
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${formatOpacity(alpha)})`;
  }

  return color;
}

function isTransparentColor(color: string | undefined | null): boolean {
  if (!color) return true;

  const value = color.trim().toLowerCase();
  if (!value || value === 'transparent' || value === 'none') return true;

  const hex = value.replace(/^#/u, '');
  if (/^[0-9a-f]{4}$/iu.test(hex)) {
    return hex[3] === '0';
  }
  if (/^[0-9a-f]{8}$/iu.test(hex)) {
    return hex.slice(6, 8) === '00';
  }

  const rgb = value.match(/^rgba\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*([0-9.]+)\s*\)$/iu);
  if (rgb) {
    return Number(rgb[1]) === 0;
  }

  return false;
}

function firstVisibleColor(...colors: Array<string | undefined>): string | undefined {
  for (const color of colors) {
    if (color && !isTransparentColor(color)) {
      return color;
    }
  }
  return undefined;
}

function parseRgb(color: string): [number, number, number] | null {
  const value = color.trim();
  const hex = value.replace(/^#/u, '');

  if (/^[0-9a-f]{3}$/iu.test(hex)) {
    return hex
      .split('')
      .map((part) => parseInt(`${part}${part}`, 16)) as [number, number, number];
  }

  if (/^[0-9a-f]{6}$/iu.test(hex) || /^[0-9a-f]{8}$/iu.test(hex)) {
    const normalized = hex.slice(0, 6);
    return [
      parseInt(normalized.slice(0, 2), 16),
      parseInt(normalized.slice(2, 4), 16),
      parseInt(normalized.slice(4, 6), 16),
    ];
  }

  const rgb = value.match(
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*[0-9.]+)?\s*\)$/iu,
  );
  if (!rgb) return null;

  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

function relativeLuminance(color: string): number | null {
  const rgb = parseRgb(color);
  if (!rgb) return null;

  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    if (normalized <= 0.03928) return normalized / 12.92;
    return ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number | null {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  if (fg === null || bg === null) return null;

  const light = Math.max(fg, bg);
  const dark = Math.min(fg, bg);
  return (light + 0.05) / (dark + 0.05);
}

function accessibleForeground(background: string, preferred?: string): string {
  if (preferred) {
    const ratio = contrastRatio(preferred, background);
    if (ratio !== null && ratio >= 4.5) {
      return preferred;
    }
  }

  const black = '#151313';
  const white = '#ffffff';
  const blackRatio = contrastRatio(black, background) ?? 0;
  const whiteRatio = contrastRatio(white, background) ?? 0;
  return blackRatio >= whiteRatio ? black : white;
}

function interactionOverlay(foreground: string, opacity: number): string {
  return withAlpha(foreground, opacity);
}

function resolveTokenValue(value: string, tokens: ResolvedTheme, seen: Set<string> = new Set()): string {
  const match = value.trim().match(/^var\(--([a-z0-9-]+)\)$/iu);
  if (!match) return value;

  const key = match[1];
  if (seen.has(key)) return value;

  const next = tokens[key];
  if (!next) return value;

  seen.add(key);
  return resolveTokenValue(next, tokens, seen);
}

function materializeTokens(tokens: ResolvedTheme): ResolvedTheme {
  const out: ResolvedTheme = {};
  for (const [key, value] of Object.entries(tokens)) {
    out[key] = resolveTokenValue(value, tokens);
  }
  return out;
}

function token(tokens: ResolvedTheme, key: string, fallback: string): string {
  return tokens[key] ?? fallback;
}

function buildTheme(
  desktopTheme: DesktopTheme,
  variant: ThemeVariant,
  resolved: ResolvedTheme,
  mode: 'light' | 'dark',
): OpenChamberTheme {
  const isDark = mode === 'dark';
  const background = token(resolved, 'background-base', isDark ? '#151313' : '#FFFCF0');
  const foreground = token(resolved, 'text-base', isDark ? '#CECDC3' : '#100F0F');
  const weakText = token(resolved, 'text-weak', token(resolved, 'text-weaker', foreground));
  const weakerText = token(resolved, 'text-weaker', weakText);
  const strongText = token(resolved, 'text-strong', foreground);
  const surfaceWeak = token(resolved, 'surface-weak', token(resolved, 'background-weak', background));
  const surfaceRaised = token(resolved, 'surface-raised-base', surfaceWeak);
  const surfaceRaisedHover = token(resolved, 'surface-raised-base-hover', surfaceRaised);
  const surfaceRaisedActive = token(resolved, 'surface-raised-base-active', surfaceRaisedHover);
  const surfaceBase = token(resolved, 'surface-base', surfaceWeak);
  const surfaceBaseHover = token(resolved, 'surface-base-hover', surfaceBase);
  const surfaceBaseActive = token(resolved, 'surface-base-active', surfaceBaseHover);
  const surfaceStrong = token(resolved, 'surface-strong', surfaceRaised);
  const borderBase = token(resolved, 'border-base', withAlpha(foreground, isDark ? 0.2 : 0.16));
  const borderHover = token(resolved, 'border-hover', borderBase);
  const borderFocus = token(resolved, 'border-interactive-selected', token(resolved, 'border-focus', borderHover));
  const interactiveSeed = sourceVariantColor(variant, 'interactive') ?? sourceVariantColor(variant, 'primary') ?? borderFocus;
  const primaryBase = sourceVariantColor(variant, 'primary') ?? token(resolved, 'text-interactive-base', borderFocus);
  const primaryHover = token(resolved, 'surface-brand-hover', primaryBase);
  const primaryActive = token(resolved, 'border-interactive-selected', primaryHover);
  const successBase = sourceVariantColor(variant, 'success') ?? token(resolved, 'icon-success-base', '#66800B');
  const warningBase = sourceVariantColor(variant, 'warning') ?? token(resolved, 'icon-warning-base', '#DA702C');
  const errorBase = sourceVariantColor(variant, 'error') ?? token(resolved, 'icon-critical-base', '#AF3029');
  const infoBase = sourceVariantColor(variant, 'info') ?? token(resolved, 'icon-info-base', '#205EA6');
  const accentBase = sourceVariantColor(variant, 'accent') ?? infoBase;
  const diffAddBase = sourceVariantColor(variant, 'diffAdd') ?? token(resolved, 'syntax-diff-add', successBase);
  const diffDeleteBase = sourceVariantColor(variant, 'diffDelete') ?? token(resolved, 'syntax-diff-delete', errorBase);
  const primaryForeground = accessibleForeground(primaryBase, token(resolved, 'text-on-brand-base', isDark ? '#151313' : '#ffffff'));
  const successForeground = accessibleForeground(successBase, token(resolved, 'text-on-success-base', '#ffffff'));
  const warningForeground = accessibleForeground(warningBase, token(resolved, 'text-on-warning-base', '#ffffff'));
  const errorForeground = accessibleForeground(errorBase, token(resolved, 'text-on-critical-base', '#ffffff'));
  const infoForeground = accessibleForeground(infoBase, token(resolved, 'text-on-info-base', '#ffffff'));
  const hoverOverlay = interactionOverlay(foreground, isDark ? 0.09 : 0.055);
  const selectionOverlay = interactionOverlay(foreground, isDark ? 0.12 : 0.085);
  const chartSeries = [primaryBase, infoBase, successBase, warningBase, errorBase];

  return {
    metadata: {
      id: `${desktopTheme.id}-${mode}`,
      name: desktopTheme.name,
      description: `Ported from OpenCode ${desktopTheme.name} theme (${mode} variant)`,
      author: 'OpenCode',
      version: '1.0.0',
      variant: mode,
      tags: [mode, 'opencode', 'ported', desktopTheme.id],
    },
    colors: {
      primary: {
        base: primaryBase,
        hover: primaryHover,
        active: primaryActive,
        foreground: primaryForeground,
        muted: withAlpha(primaryBase, 0.5),
        emphasis: token(resolved, 'text-interactive-base', primaryHover),
      },
      surface: {
        background,
        foreground,
        muted: token(resolved, 'background-weak', surfaceWeak),
        mutedForeground: weakText,
        elevated: surfaceRaised,
        elevatedForeground: foreground,
        overlay: withAlpha(background, isDark ? 0.8 : 0.2),
        subtle: surfaceWeak,
      },
      interactive: {
        border: borderBase,
        borderHover: borderHover,
        borderFocus: borderFocus,
        selection: selectionOverlay,
        selectionForeground: foreground,
        focus: borderFocus,
        focusRing: withAlpha(borderFocus, isDark ? 0.38 : 0.28),
        cursor: strongText,
        hover: hoverOverlay,
        active: selectionOverlay,
      },
      status: {
        error: errorBase,
        errorForeground: errorForeground,
        errorBackground: token(resolved, 'surface-critical-weak', withAlpha(errorBase, isDark ? 0.16 : 0.12)),
        errorBorder: token(resolved, 'border-critical-base', withAlpha(errorBase, isDark ? 0.45 : 0.35)),
        warning: warningBase,
        warningForeground: warningForeground,
        warningBackground: token(resolved, 'surface-warning-weak', withAlpha(warningBase, isDark ? 0.16 : 0.12)),
        warningBorder: token(resolved, 'border-warning-base', withAlpha(warningBase, isDark ? 0.45 : 0.35)),
        success: successBase,
        successForeground: successForeground,
        successBackground: token(resolved, 'surface-success-weak', withAlpha(successBase, isDark ? 0.16 : 0.12)),
        successBorder: token(resolved, 'border-success-base', withAlpha(successBase, isDark ? 0.45 : 0.35)),
        info: infoBase,
        infoForeground: infoForeground,
        infoBackground: token(resolved, 'surface-info-weak', withAlpha(infoBase, isDark ? 0.16 : 0.12)),
        infoBorder: token(resolved, 'border-info-base', withAlpha(infoBase, isDark ? 0.45 : 0.35)),
      },
      pr: {
        open: successBase,
        draft: weakText,
        blocked: warningBase,
        merged: token(resolved, 'syntax-constant', accentBase),
        closed: errorBase,
      },
      syntax: {
        base: {
          background: surfaceRaised,
          foreground,
          comment: token(resolved, 'syntax-comment', weakText),
          keyword: token(resolved, 'syntax-keyword', accentBase),
          string: token(resolved, 'syntax-string', successBase),
          number: token(resolved, 'syntax-constant', infoBase),
          function: token(resolved, 'syntax-property', primaryBase),
          variable: token(resolved, 'syntax-variable', foreground),
          type: token(resolved, 'syntax-type', warningBase),
          operator: token(resolved, 'syntax-operator', foreground),
        },
        tokens: {
          commentDoc: token(resolved, 'syntax-comment', weakText),
          stringEscape: token(resolved, 'syntax-regexp', foreground),
          keywordImport: token(resolved, 'syntax-keyword', accentBase),
          storageModifier: token(resolved, 'syntax-keyword', accentBase),
          functionCall: token(resolved, 'syntax-property', primaryBase),
          method: token(resolved, 'syntax-property', primaryBase),
          variableProperty: token(resolved, 'syntax-property', primaryBase),
          variableOther: token(resolved, 'syntax-variable', foreground),
          variableGlobal: token(resolved, 'syntax-constant', infoBase),
          variableLocal: token(resolved, 'syntax-punctuation', weakText),
          parameter: token(resolved, 'syntax-variable', foreground),
          constant: token(resolved, 'syntax-constant', infoBase),
          class: token(resolved, 'syntax-type', warningBase),
          className: token(resolved, 'syntax-type', warningBase),
          interface: token(resolved, 'syntax-type', warningBase),
          struct: token(resolved, 'syntax-type', warningBase),
          enum: token(resolved, 'syntax-type', warningBase),
          typeParameter: token(resolved, 'syntax-type', warningBase),
          namespace: token(resolved, 'syntax-type', warningBase),
          module: token(resolved, 'syntax-keyword', accentBase),
          tag: token(resolved, 'syntax-keyword', accentBase),
          jsxTag: token(resolved, 'syntax-keyword', accentBase),
          tagAttribute: token(resolved, 'syntax-property', primaryBase),
          tagAttributeValue: token(resolved, 'syntax-string', successBase),
          boolean: token(resolved, 'syntax-constant', infoBase),
          decorator: token(resolved, 'syntax-keyword', accentBase),
          label: token(resolved, 'syntax-property', primaryBase),
          punctuation: token(resolved, 'syntax-punctuation', weakText),
          macro: token(resolved, 'syntax-keyword', accentBase),
          preprocessor: token(resolved, 'syntax-keyword', accentBase),
          regex: token(resolved, 'syntax-regexp', foreground),
          url: token(resolved, 'text-interactive-base', primaryBase),
          key: token(resolved, 'syntax-property', primaryBase),
          exception: errorBase,
        },
        highlights: {
          diffAdded: token(resolved, 'syntax-diff-add', diffAddBase),
          diffAddedBackground: token(resolved, 'surface-diff-add-weak', withAlpha(diffAddBase, isDark ? 0.18 : 0.14)),
          diffRemoved: token(resolved, 'syntax-diff-delete', diffDeleteBase),
          diffRemovedBackground: token(resolved, 'surface-diff-delete-weak', withAlpha(diffDeleteBase, isDark ? 0.18 : 0.14)),
          diffModified: token(resolved, 'icon-diff-modified-base', warningBase),
          diffModifiedBackground: token(resolved, 'surface-diff-hidden-weak', withAlpha(infoBase, isDark ? 0.18 : 0.14)),
          lineNumber: weakerText,
          lineNumberActive: foreground,
        },
      },
      header: {
        background,
        foreground,
        border: borderBase,
        icon: token(resolved, 'icon-base', weakText),
        hover: surfaceBaseHover,
      },
      sidebar: {
        background: token(resolved, 'background-weak', surfaceWeak),
        foreground: weakText,
        border: borderBase,
        icon: token(resolved, 'icon-weak-base', weakText),
        hover: surfaceBaseHover,
        active: token(resolved, 'surface-interactive-weak', surfaceBase),
        accent: primaryBase,
        accentForeground: primaryForeground,
      },
      chat: {
        background,
        userMessage: foreground,
        userMessageBackground: token(resolved, 'surface-inset-base', surfaceBase),
        assistantMessage: foreground,
        assistantMessageBackground: background,
        timestamp: weakerText,
        divider: token(resolved, 'border-weak-base', borderBase),
        typing: weakText,
      },
      markdown: {
        heading1: token(resolved, 'markdown-heading', primaryBase),
        heading2: token(resolved, 'markdown-heading', primaryBase),
        heading3: strongText,
        heading4: foreground,
        link: token(resolved, 'markdown-link', primaryBase),
        linkHover: token(resolved, 'markdown-link-text', primaryHover),
        inlineCode: token(resolved, 'markdown-code', successBase),
        inlineCodeBackground: surfaceBase,
        blockquote: token(resolved, 'markdown-block-quote', weakText),
        blockquoteBorder: borderBase,
        listMarker: withAlpha(token(resolved, 'markdown-list-item', primaryBase), 0.6),
        bold: token(resolved, 'markdown-strong', strongText),
        italic: token(resolved, 'markdown-emph', weakText),
        strikethrough: weakText,
        hr: token(resolved, 'markdown-horizontal-rule', borderBase),
      },
      tools: {
        background: surfaceBase,
        border: token(resolved, 'border-weak-base', borderBase),
        headerHover: surfaceBaseHover,
        icon: token(resolved, 'icon-weak-base', weakText),
        title: foreground,
        description: weakText,
        edit: {
          added: token(resolved, 'text-diff-add-base', diffAddBase),
          addedBackground: token(resolved, 'surface-diff-add-weak', withAlpha(diffAddBase, isDark ? 0.16 : 0.12)),
          removed: token(resolved, 'text-diff-delete-base', diffDeleteBase),
          removedBackground: token(resolved, 'surface-diff-delete-weak', withAlpha(diffDeleteBase, isDark ? 0.16 : 0.12)),
          modified: token(resolved, 'icon-diff-modified-base', warningBase),
          modifiedBackground: token(resolved, 'surface-diff-hidden-weak', withAlpha(infoBase, isDark ? 0.16 : 0.12)),
          lineNumber: weakerText,
        },
        bash: {
          background: token(resolved, 'surface-raised-base', surfaceRaised),
          foreground: foreground,
          info: infoBase,
          warning: warningBase,
          error: errorBase,
        },
        lsp: {
          background: token(resolved, 'surface-raised-base', surfaceRaised),
          foreground: foreground,
          info: infoBase,
          warning: warningBase,
          error: errorBase,
        },
      },
      forms: {
        inputBackground: token(resolved, 'input-base', surfaceRaised),
        inputForeground: foreground,
        inputBorder: token(resolved, 'border-weak-base', borderBase),
        inputBorderHover: token(resolved, 'border-weak-hover', borderHover),
        inputBorderFocus: borderFocus,
        inputPlaceholder: weakerText,
        inputDisabled: token(resolved, 'input-disabled', surfaceWeak),
        inputSelection: token(resolved, 'input-selected', surfaceBase),
        label: weakText,
        helperText: weakerText,
      },
      buttons: {
        primary: {
          bg: primaryBase,
          fg: primaryForeground,
          border: token(resolved, 'border-interactive-base', primaryBase),
          hover: primaryHover,
          active: primaryActive,
          disabled: token(resolved, 'border-disabled', surfaceWeak),
        },
        secondary: {
          bg: surfaceRaised,
          fg: foreground,
          border: borderBase,
          hover: surfaceRaisedHover,
          active: surfaceRaisedActive,
          disabled: token(resolved, 'input-disabled', surfaceWeak),
        },
        ghost: {
          bg: '#00000000',
          fg: foreground,
          border: '#00000000',
          hover: token(resolved, 'button-ghost-hover', surfaceBaseHover),
          active: token(resolved, 'button-ghost-hover2', surfaceBaseActive),
          disabled: weakerText,
        },
        destructive: {
          bg: errorBase,
          fg: errorForeground,
          border: token(resolved, 'border-critical-base', errorBase),
          hover: token(resolved, 'surface-critical-base', errorBase),
          active: token(resolved, 'border-critical-selected', errorBase),
          disabled: token(resolved, 'input-disabled', surfaceWeak),
        },
      },
      modal: {
        background: surfaceRaised,
        foreground,
        border: borderBase,
        overlay: withAlpha(background, isDark ? 0.84 : 0.24),
      },
      popover: {
        background: surfaceRaised,
        foreground,
        border: borderBase,
        shadow: isDark ? '0 18px 48px rgba(0, 0, 0, 0.45)' : '0 18px 48px rgba(15, 15, 15, 0.16)',
      },
      commandPalette: {
        background: surfaceRaised,
        foreground,
        border: borderBase,
        inputBackground: token(resolved, 'input-base', surfaceBase),
        selectedBackground: token(resolved, 'surface-interactive-weak', surfaceBase),
        selectedForeground: foreground,
        muted: weakText,
      },
      fileAttachment: {
        background: surfaceBase,
        foreground,
        border: token(resolved, 'border-weak-base', borderBase),
        icon: token(resolved, 'icon-weak-base', weakText),
        removeHover: token(resolved, 'surface-critical-weak', withAlpha(errorBase, 0.12)),
      },
      sessions: {
        background,
        foreground,
        mutedForeground: weakText,
        border: token(resolved, 'border-weaker-base', borderBase),
        hover: surfaceBaseHover,
        active: token(resolved, 'surface-interactive-weak', surfaceBase),
      },
      modelSelector: {
        background: surfaceRaised,
        foreground,
        border: borderBase,
        selectedBackground: token(resolved, 'surface-interactive-weak', surfaceBase),
        selectedForeground: foreground,
      },
      permissions: {
        background: surfaceRaised,
        foreground,
        border: borderBase,
        allow: successBase,
        allowBackground: token(resolved, 'surface-success-weak', withAlpha(successBase, 0.12)),
        deny: errorBase,
        denyBackground: token(resolved, 'surface-critical-weak', withAlpha(errorBase, 0.12)),
      },
      loading: {
        spinner: primaryBase,
        spinnerTrack: surfaceWeak,
        skeleton: surfaceBase,
        shimmer: surfaceBaseHover,
      },
      scrollbar: {
        track: 'transparent',
        thumb: withAlpha(foreground, isDark ? 0.2 : 0.15),
        thumbHover: withAlpha(foreground, isDark ? 0.34 : 0.25),
      },
      badges: {
        default: {
          bg: surfaceBase,
          fg: foreground,
          border: token(resolved, 'border-weak-base', borderBase),
        },
        info: {
          bg: token(resolved, 'surface-info-weak', withAlpha(infoBase, 0.12)),
          fg: infoBase,
          border: token(resolved, 'border-info-base', withAlpha(infoBase, 0.35)),
        },
        success: {
          bg: token(resolved, 'surface-success-weak', withAlpha(successBase, 0.12)),
          fg: successBase,
          border: token(resolved, 'border-success-base', withAlpha(successBase, 0.35)),
        },
        warning: {
          bg: token(resolved, 'surface-warning-weak', withAlpha(warningBase, 0.12)),
          fg: warningBase,
          border: token(resolved, 'border-warning-base', withAlpha(warningBase, 0.35)),
        },
        error: {
          bg: token(resolved, 'surface-critical-weak', withAlpha(errorBase, 0.12)),
          fg: errorBase,
          border: token(resolved, 'border-critical-base', withAlpha(errorBase, 0.35)),
        },
      },
      toast: {
        background: surfaceRaised,
        foreground,
        border: borderBase,
        success: {
          background: token(resolved, 'surface-success-weak', withAlpha(successBase, 0.12)),
          foreground: successBase,
          border: token(resolved, 'border-success-base', withAlpha(successBase, 0.35)),
        },
        warning: {
          background: token(resolved, 'surface-warning-weak', withAlpha(warningBase, 0.12)),
          foreground: warningBase,
          border: token(resolved, 'border-warning-base', withAlpha(warningBase, 0.35)),
        },
        error: {
          background: token(resolved, 'surface-critical-weak', withAlpha(errorBase, 0.12)),
          foreground: errorBase,
          border: token(resolved, 'border-critical-base', withAlpha(errorBase, 0.35)),
        },
        info: {
          background: token(resolved, 'surface-info-weak', withAlpha(infoBase, 0.12)),
          foreground: infoBase,
          border: token(resolved, 'border-info-base', withAlpha(infoBase, 0.35)),
        },
      },
      emptyState: {
        icon: weakText,
        title: foreground,
        description: weakText,
        border: token(resolved, 'border-weaker-base', borderBase),
      },
      table: {
        border: token(resolved, 'border-weaker-base', borderBase),
        headerBackground: surfaceRaised,
        headerForeground: foreground,
        rowHover: surfaceBaseHover,
        rowSelected: token(resolved, 'surface-interactive-weak', surfaceBase),
      },
      charts: {
        series: chartSeries,
      },
      a11y: {
        focusRing: borderFocus,
        selection: token(resolved, 'surface-interactive-weak', surfaceBase),
        highContrast: false,
      },
      shadows: {
        sm: isDark ? '0 2px 8px rgba(0, 0, 0, 0.22)' : '0 2px 8px rgba(15, 15, 15, 0.08)',
        md: isDark ? '0 12px 32px rgba(0, 0, 0, 0.32)' : '0 12px 32px rgba(15, 15, 15, 0.12)',
        lg: isDark ? '0 24px 56px rgba(0, 0, 0, 0.42)' : '0 24px 56px rgba(15, 15, 15, 0.16)',
        focus: `0 0 0 3px ${withAlpha(interactiveSeed, isDark ? 0.35 : 0.25)}`,
      },
      animation: {
        fast: '150ms ease',
        normal: '250ms ease',
        slow: '350ms ease',
        emphasis: '450ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    },
    config: DEFAULT_CONFIG,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    await listThemes(args.opencodeRoot);
    return;
  }

  if (args.specs.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const resolveThemeVariant = await loadResolver(args.opencodeRoot);
  const generated: Array<{ fileName: string; theme: OpenChamberTheme }> = [];

  for (const spec of args.specs) {
    const themePath = await resolveThemeSpec(spec, args.opencodeRoot);
    const source = await loadThemeSource(themePath);

    if (isDesktopTheme(source)) {
      const lightResolved = materializeTokens(resolveThemeVariant(source.light, false));
      const darkResolved = materializeTokens(resolveThemeVariant(source.dark, true));

      generated.push(
        {
          fileName: `${source.id}-light.json`,
          theme: buildTheme(source, source.light, lightResolved, 'light'),
        },
        {
          fileName: `${source.id}-dark.json`,
          theme: buildTheme(source, source.dark, darkResolved, 'dark'),
        },
      );
      continue;
    }

    if (isContextTheme(source)) {
      const id = sourceThemeId(themePath);
      const name = sourceThemeName(themePath);
      const syntheticTheme: DesktopTheme = {
        id,
        name,
        light: { palette: { neutral: '#ffffff', primary: '#000000', success: '#000000', warning: '#000000', error: '#000000', info: '#000000' } },
        dark: { palette: { neutral: '#000000', primary: '#ffffff', success: '#ffffff', warning: '#ffffff', error: '#ffffff', info: '#ffffff' } },
      };

      for (const mode of ['light', 'dark'] as const) {
        const resolved = resolveContextTheme(source, mode);
        const variant = syntheticVariantFromResolvedTheme({
          neutral: resolved.background ?? (mode === 'dark' ? '#151313' : '#FFFCF0'),
          ink: resolved.text,
          primary: resolved.primary ?? resolved.accent ?? resolved.info ?? '#5A96BC',
          success: resolved.success ?? '#66800B',
          warning: resolved.warning ?? '#DA702C',
          error: resolved.error ?? '#AF3029',
          info: resolved.info ?? resolved.secondary ?? resolved.primary ?? '#205EA6',
          accent: resolved.accent ?? resolved.secondary ?? resolved.info ?? resolved.primary ?? '#205EA6',
          interactive: resolved.borderActive ?? resolved.primary ?? '#5A96BC',
          diffAdd: resolved.diffAdded ?? resolved.success ?? '#66800B',
          diffDelete: resolved.diffRemoved ?? resolved.error ?? '#AF3029',
        });

        generated.push({
          fileName: `${id}-${mode}.json`,
          theme: buildTheme(syntheticTheme, variant, syntheticTokensFromContextTheme(resolved, mode), mode),
        });
      }
      continue;
    }

    if (isOpenChamberTheme(source)) {
      const colors = source.colors as Record<string, any>;
      const variant = syntheticVariantFromResolvedTheme({
        neutral: colors.surface?.background ?? '#151313',
        ink: colors.surface?.foreground,
        primary: colors.primary?.base ?? '#5A96BC',
        success: colors.status?.success ?? '#66800B',
        warning: colors.status?.warning ?? '#DA702C',
        error: colors.status?.error ?? '#AF3029',
        info: colors.status?.info ?? '#205EA6',
        accent: colors.syntax?.base?.keyword ?? colors.status?.info ?? colors.primary?.base ?? '#205EA6',
        interactive: colors.interactive?.focus ?? colors.primary?.base ?? '#5A96BC',
        diffAdd: colors.syntax?.highlights?.diffAdded ?? colors.status?.success ?? '#66800B',
        diffDelete: colors.syntax?.highlights?.diffRemoved ?? colors.status?.error ?? '#AF3029',
      });

      const syntheticTheme: DesktopTheme = {
        id: source.metadata.id.replace(/-(light|dark)$/u, ''),
        name: source.metadata.name,
        light: variant,
        dark: variant,
      };

      generated.push({
        fileName: `${source.metadata.id}.json`,
        theme: buildTheme(
          syntheticTheme,
          variant,
          syntheticTokensFromOpenChamberTheme(source),
          source.metadata.variant,
        ),
      });
      continue;
    }

    throw new Error(`Unsupported theme source: ${themePath}`);
  }

  if (args.stdout) {
    const output = generated.length === 1 ? generated[0]?.theme : generated;
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  await fs.mkdir(args.outDir, { recursive: true });

  for (const { fileName, theme } of generated) {
    const outputPath = path.join(args.outDir, fileName);
    if (!args.force && (await exists(outputPath))) {
      throw new Error(`Refusing to overwrite existing file without --force: ${outputPath}`);
    }
    await fs.writeFile(outputPath, `${JSON.stringify(theme, null, 2)}\n`, 'utf8');
    console.log(`wrote ${outputPath}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
