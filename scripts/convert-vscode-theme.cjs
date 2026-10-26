#!/usr/bin/env node

// Maintainer entry point. Uses exactly the same conversion as Settings import.
require('tsx/cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireUi = createRequire(path.resolve(__dirname, '../packages/ui/package.json'));
const stripJsonComments = requireUi('strip-json-comments').default;
const { importVSCodeTheme } = require('../packages/ui/src/lib/theme/vscode/import.ts');
const { MAX_THEME_IMPORT_BYTES, ThemeImportError } = require('../packages/ui/src/lib/theme/importErrors.ts');

const THEMES_DIR = path.resolve(__dirname, '../packages/ui/src/lib/theme/themes');

// Preserve the existing Zed input format, then use the shared VS Code mapping.
function normalizeZedTheme(theme) {
  if (!theme || !Array.isArray(theme.themes) || !theme.themes[0]?.style) return theme;
  const entry = theme.themes[0];
  const s = entry.style;
  const syntax = s.syntax || {};
  return {
    name: entry.name || theme.name,
    author: entry.author || theme.author,
    type: entry.appearance === 'light' ? 'light' : 'dark',
    colors: {
      'editor.background': s['editor.background'] || s.background,
      'editor.foreground': s['editor.foreground'] || s.text,
      'sideBar.background': s['panel.background'] || s['surface.background'],
      'editorWidget.background': s['surface.background'],
      'editorWidget.foreground': s.text,
      'button.background': s['text.accent'] || s['border.focused'],
      'button.foreground': s.background,
      'button.hoverBackground': s['border.selected'] || s['text.accent'],
      'focusBorder': s['border.focused'],
      'widget.border': s.border,
      'input.border': s.border,
      'list.activeSelectionBackground': s['element.selected'],
      'editorCursor.foreground': s['text.accent'] || s.text,
      'editorLineNumber.foreground': s['editor.line_number'],
      'editorLineNumber.activeForeground': s['editor.active_line_number'],
      'editorError.foreground': s.error,
      'editorWarning.foreground': s.warning,
      'editorInfo.foreground': s.info,
      'gitDecoration.addedResourceForeground': s.created || s['version_control.added'],
      'gitDecoration.deletedResourceForeground': s.deleted || s['version_control.deleted'],
    },
    semanticTokenColors: {
      comment: syntax.comment?.color,
      keyword: syntax.keyword?.color,
      string: syntax.string?.color,
      number: syntax.number?.color,
      function: syntax.function?.color,
      method: syntax['function.definition']?.color || syntax.function?.color,
      variable: syntax.variable?.color,
      type: syntax.type?.color,
      class: syntax.type?.color,
      interface: syntax['type.interface']?.color,
      property: syntax.property?.color,
      operator: syntax.operator?.color,
      enumMember: syntax['type.enum.member']?.color || syntax.boolean?.color,
    },
  };
}

function convertVsCodeTheme(filename) {
  if (fs.statSync(filename).size > MAX_THEME_IMPORT_BYTES) throw new ThemeImportError('size');
  const text = fs.readFileSync(filename, 'utf8');
  const raw = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ''), { trailingCommas: true }));
  const theme = importVSCodeTheme(JSON.stringify(normalizeZedTheme(raw)), path.basename(filename));
  const slug = theme.metadata.name.toLowerCase().replace(/\b(light|dark)\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme';
  theme.metadata.id = `${slug}-${theme.metadata.variant}`;
  return theme;
}

function registerTheme(presets, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingImport = presets.match(new RegExp(`^import\\s+(\\w+)\\s+from\\s+['"]\\./${escapedId}\\.json['"]`, 'm'));
  const importVar = existingImport?.[1] || `theme_${id.replace(/[^a-z0-9]/g, '_')}_Raw`;
  const hasEntry = new RegExp(`^\\s*${importVar}(?:\\s+as\\s+Theme)?\\s*,?\\s*$`, 'm').test(presets);
  if (existingImport && hasEntry) return presets;
  const lines = presets.split(/\r?\n/);
  const lastImport = lines.findLastIndex((line) => /^import\s/.test(line));
  const arrayStart = lines.findIndex((line) => /^export const presetThemes\b/.test(line));
  const arrayEnd = lines.findIndex((line, index) => index > arrayStart && /^\]\s*(?:\.map\(|;)/.test(line));
  if (lastImport < 0 || arrayStart < 0 || arrayEnd < 0) throw new Error('Cannot locate the theme registry');
  if (!hasEntry) lines.splice(arrayEnd, 0, `  ${importVar},`);
  if (!existingImport) lines.splice(lastImport + 1, 0, `import ${importVar} from './${id}.json';`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  try {
    const files = args.filter((arg) => !arg.startsWith('--'));
    if (files.length !== 1 || args.some((arg) => arg.startsWith('--') && arg !== '--json' && arg !== '--quiet')) {
      throw new Error('Usage: node scripts/convert-vscode-theme.cjs <theme.json> [--quiet|--json]');
    }
    const theme = convertVsCodeTheme(files[0]);
    const registryPath = path.join(THEMES_DIR, 'presets.ts');
    const previous = fs.readFileSync(registryPath, 'utf8');
    const next = registerTheme(previous, theme.metadata.id);
    const outputPath = path.join(THEMES_DIR, `${theme.metadata.id}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(theme, null, 2)}\n`);
    if (next !== previous) fs.writeFileSync(registryPath, next);
    if (json) console.log(JSON.stringify({ id: theme.metadata.id, outputPath }));
    else console.log(quiet ? outputPath : `Converted ${theme.metadata.name}: ${outputPath}`);
  } catch (error) {
    const messages = {
      include: 'Export a self-contained theme using Developer: Generate Color Theme From Current Settings in VS Code.',
      background: 'The theme needs an editor.background color.',
      size: 'Theme files must be no larger than 512 KiB.',
      invalid: 'Not a supported VS Code color theme.',
    };
    const message = error instanceof ThemeImportError ? messages[error.code] || error.message : error.message;
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    process.exitCode = 1;
  }
}

module.exports = { convertVsCodeTheme, registerTheme };
if (require.main === module) main();
