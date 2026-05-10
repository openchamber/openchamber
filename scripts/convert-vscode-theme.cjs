#!/usr/bin/env node

/**
 * VS Code Theme to ALIAS ADE Theme Converter
 * 
 * USAGE:
 *   node scripts/convert-vscode-theme.cjs <path-to-vscode-theme.json>
 * 
 * EXAMPLE:
 *   node scripts/convert-vscode-theme.cjs \
 *     /path/to/dune-kaitain-color-theme.json
 * 
 * WHAT IT DOES:
 *   1. Reads a VS Code theme JSON file (with comments support)
 *   2. Converts it to ALIAS ADE theme format:
 *      - Extracts color palette (primary, surface, interactive, status, syntax)
 *      - Generates derived sections (markdown, chat, tools)
 *      - Adds default config (fonts, radius, transitions)
 *   3. Saves the converted theme to:
 *      packages/ui/src/lib/theme/themes/<theme-id>.json
 *   4. Auto-registers the theme in presets.ts:
 *      - Adds import statement
 *      - Adds to presetThemes array
 *      - Skips if already registered (no duplicates)
 * 
 * OUTPUT:
 *   - Theme file: packages/ui/src/lib/theme/themes/<theme-name>-<variant>.json
 *   - Updated: packages/ui/src/lib/theme/themes/presets.ts
 * 
 * COMPATIBILITY:
 *   Works with standard VS Code themes that have:
 *   - colors (UI colors)
 *   - tokenColors (TextMate scopes)
 *   - semanticTokenColors (optional, LSP tokens)
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const THEMES_DIR = path.join(
  REPO_ROOT,
  'packages',
  'ui',
  'src',
  'lib',
  'theme',
  'themes',
);
const PRESETS_PATH = path.join(THEMES_DIR, 'presets.ts');

function stripJsonComments(jsonString) {
  // Remove single-line comments (// ...)
  jsonString = jsonString.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments (/* ... */)
  jsonString = jsonString.replace(/\/\*[\s\S]*?\*\//g, '');
  return jsonString;
}

function convertVsCodeTheme(vscodeThemePath) {
  // Read VS Code theme and strip comments
  const rawContent = fs.readFileSync(vscodeThemePath, 'utf8');
  const cleanContent = stripJsonComments(rawContent);
  const vscodeTheme = JSON.parse(cleanContent);
  
  const colors = vscodeTheme.colors || {};
  const tokenColors = vscodeTheme.tokenColors || [];
  const semanticTokenColors = vscodeTheme.semanticTokenColors || {};
  
  // Determine variant
  const isDark = vscodeTheme.type === 'dark' || 
                 colors['editor.background']?.toLowerCase() < '#808080' ||
                 colors['workbench.colorTheme']?.includes('dark');
  
  const variant = isDark ? 'dark' : 'light';
  
  // Convert slug-style name to Title Case
  // e.g., "dune-kaitain" → "Dune Kaitain"
  const toTitleCase = (str) => {
    return str
      .replace(/[-_]+/g, ' ')  // Replace hyphens/underscores with spaces
      .replace(/\b\w/g, (c) => c.toUpperCase());  // Capitalize each word
  };
  
  const themeName = toTitleCase(vscodeTheme.name || 'Untitled Theme');
  
  // Extract color sets for derived sections
  const primaryColors = extractPrimaryColors(colors, semanticTokenColors);
  const surfaceColors = extractSurfaceColors(colors);
  const statusColors = extractStatusColors(colors, tokenColors, semanticTokenColors);
  const syntaxColors = extractSyntaxColors(tokenColors, semanticTokenColors, colors);
  
  // Build ALIAS ADE theme
  const aliasAdeTheme = {
    metadata: {
      id: vscodeTheme.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') + `-${variant}`,
      name: themeName,
      description: vscodeTheme.description || `Converted from VS Code theme`,
      version: vscodeTheme.version || '1.0.0',
      variant: variant,
      tags: [variant, 'converted', 'vscode']
    },
    colors: {
      primary: primaryColors,
      surface: surfaceColors,
      interactive: extractInteractiveColors(colors),
      status: statusColors,
      syntax: syntaxColors,
      markdown: generateMarkdownColors(primaryColors, surfaceColors, syntaxColors),
      chat: generateChatColors(surfaceColors),
      tools: generateToolsColors(surfaceColors, statusColors)
    },
    config: generateConfig()
  };
  
  return aliasAdeTheme;
}

// Generate markdown colors from theme palette
function generateMarkdownColors(primary, surface, syntax) {
  return {
    heading1: primary.base,
    heading2: primary.hover,
    heading3: syntax.base.keyword,
    heading4: surface.foreground,
    link: syntax.base.keyword,
    linkHover: primary.hover,
    inlineCode: syntax.base.function,
    inlineCodeBackground: surface.muted,
    blockquote: surface.mutedForeground,
    blockquoteBorder: surface.subtle,
    listMarker: primary.base + '99' // 60% opacity
  };
}

// Generate chat colors from surface palette
function generateChatColors(surface) {
  return {
    userMessage: surface.foreground,
    userMessageBackground: surface.elevated,
    assistantMessage: surface.foreground,
    assistantMessageBackground: surface.background,
    timestamp: surface.mutedForeground,
    divider: surface.subtle
  };
}

// Generate tools colors from theme palette
function generateToolsColors(surface, status) {
  return {
    background: surface.muted + '50',
    border: surface.subtle + '80',
    headerHover: surface.subtle + '50',
    icon: surface.mutedForeground,
    title: surface.foreground,
    description: surface.mutedForeground,
    edit: {
      added: status.success,
      addedBackground: status.successBackground,
      removed: status.error,
      removedBackground: status.errorBackground,
      lineNumber: surface.subtle
    }
  };
}

// Generate default config (hardcoded as requested)
function generateConfig() {
  return {
    fonts: {
      sans: "\"IBM Plex Mono\", monospace",
      mono: "\"IBM Plex Mono\", monospace",
      heading: "\"IBM Plex Mono\", monospace"
    },
    radius: {
      none: "0",
      sm: "0.125rem",
      md: "0.375rem",
      lg: "0.5rem",
      xl: "0.75rem",
      full: "9999px"
    },
    transitions: {
      fast: "150ms ease",
      normal: "250ms ease",
      slow: "350ms ease"
    }
  };
}

function extractPrimaryColors(colors, semanticTokenColors) {
  // Primary = main accent/action color
  const primary = colors['button.background'] || 
                  colors['activityBarBadge.background'] ||
                  semanticTokenColors['function']?.foreground ||
                  '#5A96BC';
  
  return {
    base: primary,
    hover: colors['button.hoverBackground'] || adjustBrightness(primary, -10),
    active: adjustBrightness(primary, 20),
    foreground: colors['button.foreground'] || '#FFFFFF',
    muted: primary + '80', // 50% opacity
    emphasis: adjustBrightness(primary, 30)
  };
}

function extractSurfaceColors(colors) {
  const bg = colors['editor.background'] || '#151313';
  const fg = colors['editor.foreground'] || '#CECDC3';
  
  return {
    background: bg,
    foreground: fg,
    muted: colors['sideBar.background'] || colors['editor.lineHighlightBackground'] || adjustBrightness(bg, 20),
    mutedForeground: colors['editorLineNumber.foreground'] || adjustBrightness(fg, -40),
    elevated: colors['editor.lineHighlightBackground'] || colors['sideBar.background'] || adjustBrightness(bg, 10),
    elevatedForeground: fg,
    overlay: bg + '80',
    subtle: colors['editorWhitespace.foreground'] || adjustBrightness(bg, 30)
  };
}

function extractInteractiveColors(colors) {
  const selection = colors['editor.selectionBackground'] || '#403E3C';
  const border = colors['input.border'] || colors['editorWhitespace.foreground'] || '#343331';
  
  return {
    border: border,
    borderHover: colors['inputOption.activeBorder'] || adjustBrightness(border, 20),
    borderFocus: colors['focusBorder'] || colors['inputOption.activeBorder'] || '#5A96BC',
    selection: selection,
    selectionForeground: colors['editor.foreground'] || '#CECDC3',
    focus: colors['focusBorder'] || '#5A96BC',
    focusRing: (colors['focusBorder'] || '#5A96BC') + '50',
    cursor: colors['editorCursor.foreground'] || '#CECDC3',
    hover: selection + '80',
    active: selection
  };
}

function extractStatusColors(colors, tokenColors, semanticTokenColors) {
  const error = colors['editorError.foreground'] || 
                semanticTokenColors['variable.defaultLibrary']?.foreground ||
                '#D14D41';
  const warning = colors['editorWarning.foreground'] || '#DA702C';
  const success = colors['gitDecoration.addedResourceForeground'] || '#879A39';
  const info = colors['editorInfo.foreground'] || '#4385BE';
  
  const bg = colors['editor.background'] || '#151313';
  
  return {
    error: error,
    errorForeground: bg,
    errorBackground: error + '20',
    errorBorder: error + '50',
    warning: warning,
    warningForeground: bg,
    warningBackground: warning + '20',
    warningBorder: warning + '50',
    success: success,
    successForeground: bg,
    successBackground: success + '20',
    successBorder: success + '50',
    info: info,
    infoForeground: bg,
    infoBackground: info + '20',
    infoBorder: info + '50'
  };
}

function extractSyntaxColors(tokenColors, semanticTokenColors, colors) {
  // Map TextMate scopes to our syntax tokens
  const scopeMap = {};
  
  tokenColors.forEach(tc => {
    const scopes = Array.isArray(tc.scope) ? tc.scope : [tc.scope];
    const color = tc.settings?.foreground;
    if (color) {
      scopes.forEach(scope => {
        scopeMap[scope] = color;
      });
    }
  });
  
  // Get semantic token colors with fallback to TextMate
  const getColor = (semantic, textmateScopes, fallback) => {
    // Check semantic first
    if (semanticTokenColors[semantic]) {
      const stc = semanticTokenColors[semantic];
      return typeof stc === 'string' ? stc : stc.foreground;
    }
    // Check TextMate scopes
    for (const scope of textmateScopes) {
      if (scopeMap[scope]) return scopeMap[scope];
    }
    return fallback;
  };
  
  const editorBg = colors['editor.background'] || '#1C1B1A';
  const editorFg = colors['editor.foreground'] || '#CECDC3';
  
  const syntax = {
    base: {
      background: editorBg,
      foreground: editorFg,
      comment: getColor('comment', ['comment', 'punctuation.definition.comment'], '#878580'),
      keyword: getColor('keyword', ['keyword', 'keyword.control', 'storage'], '#CC6B49'),
      string: getColor('string', ['string', 'string.quoted'], '#7FB069'),
      number: getColor('number', ['constant.numeric'], '#e2ad4a'),
      function: getColor('function', ['entity.name.function', 'support.function'], '#5A96BC'),
      variable: getColor('variable', ['variable'], '#CECDC3'),
      type: getColor('type', ['entity.name.type', 'support.type'], '#e0a98eff'),
      operator: getColor('operator', ['keyword.operator'], '#CC6B49')
    },
    tokens: {
      // Extended tokens
      commentDoc: getColor('comment', ['comment.documentation'], '#575653'),
      stringEscape: getColor('string', ['constant.character.escape'], editorFg),
      keywordImport: getColor('keyword', ['keyword.control.import'], '#D14D41'),
      storageModifier: getColor('keyword', ['storage.modifier'], '#4385BE'),
      functionCall: getColor('function', ['entity.name.function'], '#5A96BC'),
      method: getColor('method', ['entity.name.function.method'], '#879A39'),
      variableProperty: getColor('property', ['variable.other.object.property'], '#de956a'),
      variableOther: getColor('variable', ['variable.other'], '#879A39'),
      class: getColor('class', ['entity.name.type.class'], '#e0a98eff'),
      className: getColor('class', ['entity.name.type.class'], '#e0a98eff'),
      interface: getColor('interface', ['entity.name.type.interface'], '#e0a98eff'),
      tag: getColor('function', ['entity.name.tag'], '#4385BE'),
      boolean: getColor('enumMember', ['constant.language.boolean'], '#e2ad4a'),
      url: getColor('string', ['string.other.link'], '#4385BE'),
      key: getColor('property', ['meta.object-literal.key'], '#DA702C')
    },
    highlights: {
      diffAdded: colors['gitDecoration.addedResourceForeground'] || '#879A39',
      diffAddedBackground: (colors['gitDecoration.addedResourceForeground'] || '#879A39') + '20',
      diffRemoved: colors['gitDecoration.deletedResourceForeground'] || '#D14D41',
      diffRemovedBackground: (colors['gitDecoration.deletedResourceForeground'] || '#D14D41') + '20',
      lineNumber: colors['editorLineNumber.foreground'] || '#878580',
      lineNumberActive: colors['editorLineNumber.activeForeground'] || editorFg
    }
  };
  
  return syntax;
}

// Helper: adjust brightness of hex color
function adjustBrightness(hex, percent) {
  // Remove # if present
  hex = hex.replace('#', '');
  
  // Parse RGB
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);
  
  // Adjust brightness
  r = Math.min(255, Math.max(0, r + (r * percent / 100)));
  g = Math.min(255, Math.max(0, g + (g * percent / 100)));
  b = Math.min(255, Math.max(0, b + (b * percent / 100)));
  
  // Convert back to hex
  return '#' + 
    Math.round(r).toString(16).padStart(2, '0') +
    Math.round(g).toString(16).padStart(2, '0') +
    Math.round(b).toString(16).padStart(2, '0');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeImportVariableName(themeId) {
  const base = themeId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const safeBase = /^[a-z_]/.test(base) ? base : `_${base}`;
  return `${safeBase}_Raw`;
}

function registerThemeInPresets(themeId) {
  if (!fs.existsSync(PRESETS_PATH)) {
    throw new Error(`presets.ts not found at: ${PRESETS_PATH}`);
  }

  const importPath = `./${themeId}.json`;
  const presetsSource = fs.readFileSync(PRESETS_PATH, 'utf8');
  const importVar = makeImportVariableName(themeId);
  const importLine = `import ${importVar} from '${importPath}';`;
  const arrayEntry = `${importVar} as Theme`;

  // Check if already imported
  const importExists = presetsSource.includes(importLine);
  
  // Check if already in array
  const arrayEntryExists = presetsSource.includes(arrayEntry);

  // If both exist, nothing to do
  if (importExists && arrayEntryExists) {
    console.log(`   Theme already registered: ${themeId}`);
    return { updated: false, importVar, alreadyInArray: true, source: presetsSource };
  }

  let nextSource = presetsSource;
  let updated = false;

  // Add import if missing
  if (!importExists) {
    const lines = presetsSource.split(/\r?\n/);
    let lastImportLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s/.test(lines[i])) lastImportLine = i;
    }

    if (lastImportLine === -1) {
      throw new Error('Unable to find import block in presets.ts');
    }

    lines.splice(lastImportLine + 1, 0, importLine);
    nextSource = lines.join('\n');
    updated = true;
  }

  // Add to array if missing
  if (!arrayEntryExists) {
    const lines = nextSource.split(/\r?\n/);
    const arrayStartIndex = lines.findIndex((line) => /^\s*export\s+const\s+presetThemes\b/.test(line));
    if (arrayStartIndex === -1) {
      throw new Error('Unable to find presetThemes declaration in presets.ts');
    }

    const arrayEndIndex = lines.findIndex(
      (line, index) => index > arrayStartIndex && /^\s*\];\s*$/.test(line),
    );
    if (arrayEndIndex === -1) {
      throw new Error('Unable to find presetThemes array end (];) in presets.ts');
    }

    lines.splice(arrayEndIndex, 0, `  ${arrayEntry},`);
    nextSource = lines.join('\n');
    updated = true;
  }

  return { updated, importVar, source: nextSource, alreadyInArray: arrayEntryExists };
}

function writeThemeToDisk(theme) {
  if (!fs.existsSync(THEMES_DIR)) {
    throw new Error(`Themes directory not found: ${THEMES_DIR}`);
  }

  const outputName = `${theme.metadata.id}.json`;
  const outputPath = path.join(THEMES_DIR, outputName);
  fs.writeFileSync(outputPath, JSON.stringify(theme, null, 2));
  return outputPath;
}

function convertWriteAndRegisterTheme(inputPath) {
  const theme = convertVsCodeTheme(inputPath);
  const outputPath = writeThemeToDisk(theme);

  const registration = registerThemeInPresets(theme.metadata.id);
  if (registration.updated) fs.writeFileSync(PRESETS_PATH, registration.source);

  return { theme, outputPath, registration };
}

// Main execution
if (process.argv.length < 3) {
  console.error('Usage: node convert-vscode-theme.js <path-to-vscode-theme.json>');
  process.exit(1);
}

const inputPath = process.argv[2];

if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

try {
  const { theme, outputPath, registration } = convertWriteAndRegisterTheme(inputPath);

  console.log(`✅ Converted: ${inputPath}`);
  console.log(`📄 Output: ${outputPath}`);
  console.log(`\nTheme ID: ${theme.metadata.id}`);
  console.log(`Variant: ${theme.metadata.variant}`);

  if (registration?.importVar) {
    console.log(`Preset import: ${registration.importVar}`);
  }
} catch (err) {
  console.error('❌ Conversion failed:', err.message);
  process.exit(1);
}
