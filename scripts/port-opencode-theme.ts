#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { resolveThemeVariant } from '../../opencode/packages/ui/src/theme/resolve';
import { resolveThemeVariantV2 } from '../../opencode/packages/ui/src/theme/v2/resolve';
import { importVSCodeTheme } from '../packages/ui/src/lib/theme/vscode/import';
import { compactTheme, requireTheme, type ThemeDefinition } from '../packages/ui/src/lib/theme/definition';
import { mixColor, onColor, readableText } from '../packages/ui/src/lib/theme/color';

// The source checkout must be installed beside OpenChamber. It is read-only.
const sourceRoot = resolve(import.meta.dirname, '../../opencode/packages/ui/src');
const sourceDirectory = join(sourceRoot, 'theme/themes');
const defaultOutput = join(homedir(), '.config/openchamber/themes');
const primitiveCss = readFileSync(join(sourceRoot, 'styles/tokens/colors.css'), 'utf8');
const primitiveTokens = Object.fromEntries([...primitiveCss.matchAll(/--(v2-[a-z0-9-]+):\s*(#[\da-f]+)\s*;/gi)].map((match) => [match[1], match[2]]));
const hex = z.templateLiteral(['#', z.string()]).refine((value) => /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value));
const reference = z.templateLiteral(['var(--', z.string(), ')']).refine((value) => /^var\(--[a-z0-9-]+\)$/.test(value));
// OC-2 ships icon-weak-base as "C7C7C7", without the #.
const bareHex = z.string().regex(/^[\da-f]{6}$/i).transform((value) => hex.parse(`#${value}`));
const colors = { neutral: hex, primary: hex, success: hex, warning: hex, error: hex, info: hex };
const overrides = {
  overrides: z.record(z.string(), z.union([hex, reference, bareHex, z.string().regex(/^rgba?\(/).transform((value) => hex.parse(literalColor(value)))])).optional(),
  v2Overrides: z.record(z.string(), z.string()).optional(),
};
const variant = z.union([
  z.object({ palette: z.object({ ...colors, ink: hex, accent: hex.optional(), interactive: hex.optional(), diffAdd: hex.optional(), diffDelete: hex.optional() }), seeds: z.never().optional(), ...overrides }),
  z.object({ seeds: z.object({ ...colors, interactive: hex, diffAdd: hex, diffDelete: hex }), palette: z.never().optional(), ...overrides }),
]);
export const sourceSchema = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1).max(120), light: variant, dark: variant });
type SourceTheme = z.output<typeof sourceSchema>;
type Mode = 'light' | 'dark';

// Resolve only consumed colors. Upstream shadow/font tokens are not colors.
export function tokenColor(tokens: ReadonlyMap<string, string>, key: string, chain: string[] = []): string {
  if (chain.includes(key)) throw new Error(`Circular color reference: ${[...chain, key].join(' -> ')}`);
  const value = tokens.get(key)?.trim();
  if (!value) throw new Error(`Missing OpenCode color: ${key}`);
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (ref) return tokenColor(tokens, ref[1], [...chain, key]);
  return literalColor(value);
}

function literalColor(value: string): string {
  if (hex.safeParse(value).success) return value;
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value);
  if (rgb) {
    const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (channels.every((channel) => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1) {
      return '#' + [...channels, alpha * 255].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('');
    }
  }
  throw new Error(`Unsupported OpenCode color: ${value}`);
}

export function convertTheme(source: SourceTheme, mode: Mode): ThemeDefinition {
  const dark = mode === 'dark';
  const tokens = new Map(Object.entries({
    ...primitiveTokens,
    ...resolveThemeVariant(source[mode], dark),
    ...resolveThemeVariantV2(source[mode], dark),
  }));
  const color = (key: string) => tokenColor(tokens, key);
  const canvas = mixColor(color('v2-background-bg-base'), dark ? '#000000' : '#ffffff', 1);
  const sidebar = mixColor(color('v2-background-bg-deep'), canvas, 1);
  const elevated = mixColor(color('v2-background-bg-layer-01'), canvas, 1);
  const foreground = color('v2-text-text-base');
  const selection = color('v2-background-bg-layer-03');
  const accent = color('v2-text-text-accent');
  const palette = {
    'chat.list.background': canvas,
    'foreground': foreground,
    'interactive-session.foreground': foreground,
    'descriptionForeground': color('v2-text-text-muted'),
    'sideBar.background': sidebar,
    'sideBar.foreground': foreground,
    'editorWidget.background': elevated,
    'editorWidget.foreground': readableText(foreground, elevated, canvas),
    'editor.background': mixColor(color('background-stronger'), canvas, 1),
    'editor.foreground': color('text-base'),
    'editorLineNumber.foreground': color('text-weak'),
    'widget.border': color('v2-border-border-base'),
    'toolbar.hoverOutline': color('v2-border-border-strong'),
    'focusBorder': color('v2-border-border-focus'),
    'toolbar.hoverBackground': color('v2-overlay-simple-overlay-hover'),
    'toolbar.activeBackground': color('v2-overlay-simple-overlay-pressed'),
    'list.activeSelectionBackground': selection,
    'list.activeSelectionForeground': readableText(foreground, selection, canvas),
    // Primary also paints small activity indicators; use the text accent.
    'button.background': accent,
    'button.foreground': onColor(accent, canvas),
    'button.hoverBackground': color('v2-text-text-accent-hover'),
    'textLink.foreground': accent,
    'editorError.foreground': color('v2-state-fg-danger'),
    'editorError.background': color('v2-state-bg-danger'),
    'editorWarning.foreground': color('v2-state-fg-warning'),
    'editorWarning.background': color('v2-state-bg-warning'),
    'testing.iconPassed': color('v2-state-fg-success'),
    'editorInfo.foreground': color('v2-state-fg-info'),
    'editorInfo.background': color('v2-state-bg-info'),
    'gitDecoration.addedResourceForeground': color('syntax-diff-add'),
    'gitDecoration.deletedResourceForeground': color('syntax-diff-delete'),
    'gitDecoration.modifiedResourceForeground': color('icon-diff-modified-base'),
    'diffEditor.insertedLineBackground': color('surface-diff-add-base'),
    'diffEditor.removedLineBackground': color('surface-diff-delete-base'),
    'chat.requestBubbleBackground': elevated,
    'textPreformat.foreground': color('markdown-code'),
    'textPreformat.background': color('background-stronger'),
    'textBlockQuote.foreground': color('markdown-block-quote'),
  };
  // Matches OpenCode's context/marked-theme.tsx semantic-token mapping.
  const semanticTokenColors = {
    comment: color('syntax-comment'), keyword: color('syntax-keyword'),
    string: color('syntax-string'), number: color('syntax-constant'),
    function: color('syntax-primitive'), method: color('syntax-primitive'),
    variable: color('syntax-variable'), parameter: color('syntax-variable'),
    property: color('syntax-property'), type: color('syntax-type'),
    class: color('syntax-type'), operator: color('syntax-operator'),
    'variable.readonly': color('syntax-constant'),
  };
  const imported = importVSCodeTheme(JSON.stringify({
    name: source.name, type: mode, colors: palette, semanticTokenColors,
    tokenColors: [
      { scope: 'punctuation', settings: { foreground: color('syntax-punctuation') } },
      { scope: 'entity.name.tag', settings: { foreground: color('syntax-string') } },
      { scope: 'constant.character.escape', settings: { foreground: color('syntax-constant') } },
    ],
  }), `${source.id}.json`);
  const result = compactTheme({
    ...imported,
    metadata: {
      id: `opencode-app-${source.id}-${mode}`,
      name: `OpenCode App / ${source.name} / ${dark ? 'Dark' : 'Light'}`,
      variant: mode, version: '1.0.0', tags: ['imported', 'opencode-app'],
      description: `Adapted from the OpenCode desktop ${source.name} theme using its v1 and v2 resolvers.`,
    },
    colors: {
      ...imported.colors,
      surface: { ...imported.colors.surface, overlay: color('v2-overlay-simple-overlay-scrim') },
      syntax: {
        ...imported.colors.syntax,
        tokens: { ...imported.colors.syntax.tokens, regex: color('syntax-regexp') },
      },
    },
  });
  requireTheme(result);
  return result;
}

// Publish complete files without overwriting edits or symlinks. A failed sibling
// leaves successful files valid; identical output can be retried safely.
export async function saveTheme(directory: string, theme: ThemeDefinition): Promise<'created' | 'unchanged'> {
  const text = JSON.stringify(theme, null, 2) + '\n';
  const target = join(directory, `${theme.metadata.id}.json`);
  const temporary = join(directory, `.${theme.metadata.id}-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(text);
    await handle.close();
    try {
      await link(temporary, target);
      return 'created';
    } catch (error) {
      if (!z.object({ code: z.literal('EEXIST') }).safeParse(error).success) throw error;
      const stat = await lstat(target);
      if (stat.isFile() && stat.size === Buffer.byteLength(text) && await readFile(target, 'utf8') === text) return 'unchanged';
      throw new Error(`Refusing to replace existing file: ${target}`);
    }
  } finally {
    await handle.close();
    await unlink(temporary);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    theme: { type: 'string', multiple: true }, mode: { type: 'string', default: 'both' },
    output: { type: 'string', default: defaultOutput },
    'dry-run': { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  }, allowPositionals: false });
  if (values.help) {
    console.log(`Convert OpenCode App themes to OpenChamber custom themes.

bun run themes:port:opencode [options]

  --theme ID       Convert one theme; repeat to select several
  --mode MODE      light, dark, or both (default)
  --output PATH    Output directory; defaults to ~/.config/openchamber/themes
  --dry-run        Validate conversion without writing files
  --list           List available theme IDs
  --help           Show this help

Requires an installed OpenCode checkout at ../opencode beside OpenChamber.
Existing identical files are skipped. Different files are never overwritten.`);
    return;
  }
  const mode = z.enum(['light', 'dark', 'both']).parse(values.mode);
  const requested = new Set(values.theme ?? []);
  const found = new Set<string>();
  const ids = new Set<string>();
  const output = resolve(values.output);
  let converted = 0, created = 0, unchanged = 0, failed = 0;
  const files = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.json')).sort();
  if (!files.length) throw new Error(`No themes found in ${sourceDirectory}`);
  for (const filename of files) {
    try {
      const source = sourceSchema.parse(JSON.parse(await readFile(join(sourceDirectory, filename), 'utf8')));
      if (ids.has(source.id)) throw new Error(`Duplicate source theme ID: ${source.id}`);
      ids.add(source.id);
      if (requested.size && !requested.has(source.id)) continue;
      found.add(source.id);
      if (values.list) { console.log(`${source.id}\t${source.name}`); continue; }
      const modes: Mode[] = mode === 'both' ? ['light', 'dark'] : [mode];
      for (const variantMode of modes) {
        try {
          const theme = convertTheme(source, variantMode);
          converted++;
          if (values['dry-run']) continue;
          const outcome = await saveTheme(output, theme);
          if (outcome === 'created') created++;
          else unchanged++;
        } catch (error) {
          failed++;
          console.error(`${source.id}/${variantMode}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      failed++;
      console.error(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const id of requested) {
    if (!found.has(id)) { failed++; console.error(`Unknown theme: ${id}. Use --list to see available IDs.`); }
  }
  if (!values.list) {
    console.log(values['dry-run']
      ? `Validated ${converted} variants. Errors: ${failed}. No files written.`
      : `Created ${created}; unchanged ${unchanged}; errors ${failed}.\nOutput: ${output}`);
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
