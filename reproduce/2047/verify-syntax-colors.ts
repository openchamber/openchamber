/**
 * Verification script for Issue #2047
 *
 * This checks the VS Code theme adapter's syntax color mapping.
 * Run with: bun run reproduce/2047/verify-syntax-colors.ts
 *
 * It tests whether getMarkdownSyntaxVars produces distinct colors
 * when used with the VS Code adapted theme.
 */

import { buildVSCodeThemeFromPalette, type VSCodeThemePalette } from 
  '../../packages/ui/src/lib/theme/vscode/adapter';
import { getMarkdownSyntaxVars } from 
  '../../packages/ui/src/components/chat/markdown/markdownTheme';
import { getDefaultTheme } from '../../packages/ui/src/lib/theme/themes';
import type { Theme } from '../../packages/ui/src/types/theme';

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (!match) return null;
  let h = match[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return 0;
  return Math.sqrt(
    (ra.r - rb.r) ** 2 +
    (ra.g - rb.g) ** 2 +
    (ra.b - rb.b) ** 2
  );
}

function analyzeTheme(name: string, theme: Theme) {
  console.log(`\n=== ${name} ===`);
  
  const vars = getMarkdownSyntaxVars(theme);
  const entries = Object.entries(vars);
  
  // Check foreground (base text color)
  const fgKey = '--md-syntax-foreground';
  const fgValue = vars[fgKey];
  console.log(`  ${fgKey}: ${fgValue}`);
  
  // Check keyword distinct from foreground
  const keywordValue = vars['--md-syntax-keyword'];
  const dist = fgValue ? colorDistance(fgValue, keywordValue) : 0;
  console.log(`  --md-syntax-keyword: ${keywordValue} (distance from foreground: ${dist.toFixed(0)})`);
  if (dist < 30) {
    console.log(`  ⚠ keyword is very close to foreground color — may appear same as plain text`);
  }
  
  // Check for any duplicate values (tokens that would look the same)
  const valueMap = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const existing = valueMap.get(value) || [];
    existing.push(key);
    valueMap.set(value, existing);
  }
  
  console.log('');
  let allDistinct = true;
  for (const [value, keys] of valueMap.entries()) {
    if (keys.length > 1) {
      allDistinct = false;
      console.log(`  ✗ DUPLICATE: "${value}" used for: ${keys.join(', ')}`);
    }
  }
  
  if (allDistinct) {
    console.log('  ✓ All syntax CSS variables have unique values');
  }
  
  // Check distances between each pair
  const syntaxKeys = entries.filter(([k]) => k !== '--md-syntax-foreground' && k !== '--md-syntax-background');
  let minDistance = Infinity;
  let minPair = '';
  for (let i = 0; i < syntaxKeys.length; i++) {
    for (let j = i + 1; j < syntaxKeys.length; j++) {
      const d = colorDistance(syntaxKeys[i][1], syntaxKeys[j][1]);
      if (d < minDistance) {
        minDistance = d;
        minPair = `${syntaxKeys[i][0]} vs ${syntaxKeys[j][0]}`;
      }
    }
  }
  console.log(`  Minimum pairwise distance: ${minDistance.toFixed(0)} (${minPair})`);
  if (minDistance < 20) {
    console.log(`  ⚠ Some syntax colors may be hard to distinguish`);
  }
}

function testVSCodeVSDefault() {
  // Simulate a minimal VS Code dark theme palette (many minimal themes don't set all colors)
  const minimalPalette: VSCodeThemePalette = {
    kind: 'dark',
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'interactive-session.foreground': '#d4d4d4',
      'chat.list.background': '#252526',
      'foreground': '#cccccc',
      // Note: many ANSI terminal colors NOT set
    },
    mode: 'dark',
  };

  const theme = buildVSCodeThemeFromPalette(minimalPalette);
  analyzeTheme('VS Code Minimal Theme (missing most terminal colors)', theme);

  // Simulate a VS Code theme with all terminal colors set to similar muted values
  const mutedPalette: VSCodeThemePalette = {
    kind: 'dark',
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'interactive-session.foreground': '#d4d4d4',
      'chat.list.background': '#252526',
      'foreground': '#cccccc',
      'editorLineNumber.foreground': '#858585',
      'terminal.ansiBlue': '#808080',
      'terminal.ansiGreen': '#808080',
      'terminal.ansiYellow': '#808080',
      'terminal.ansiCyan': '#808080',
      'terminal.ansiMagenta': '#808080',
      'terminal.ansiRed': '#808080',
      'descriptionForeground': '#808080',
      'button.background': '#808080',
    },
    mode: 'dark',
  };

  const mutedTheme = buildVSCodeThemeFromPalette(mutedPalette);
  analyzeTheme('VS Theme with all-gray terminal ANSI colors', mutedTheme);

  // Default themes
  const defaultLight = getDefaultTheme(false);
  const defaultDark = getDefaultTheme(true);
  analyzeTheme('Default Light Theme', defaultLight);
  analyzeTheme('Default Dark Theme', defaultDark);
}

console.log('=== Issue #2047: Syntax Highlight Verification ===\n');
testVSCodeVSDefault();
console.log('\n=== Key Findings ===\n');
console.log('1. The VS Code adapter uses terminal.ansiBlue for keywords,');
console.log('   terminal.ansiYellow for numbers AND types (duplicate!),');
console.log('   terminal.ansiGreen for strings, terminal.ansiCyan for functions.');
console.log('');
console.log('2. If a VS Code theme does not set terminal.* colors,');
console.log('   all fall back to similar muted/base colors.');
console.log('');
console.log('3. The "full gray text block" symptom matches when:');
console.log('   a) The Shiki worker fails to load in the webview, OR');
console.log('   b) All --md-syntax-* CSS vars resolve to similar gray values');
console.log('');
console.log('4. In VS Code, the Shiki worker chunk (markdown-shiki-worker-[hash].js)');
console.log('   must be accessible via vscode-resource://. If CSP or');
console.log('   localResourceRoots blocks it, all highlighting silently fails.');
