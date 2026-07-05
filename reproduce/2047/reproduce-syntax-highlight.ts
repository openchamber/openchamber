/**
 * Reproduction for issue #2047: Syntax code highlight doesn't work in VS Code
 *
 * This script traces through the syntax highlighting pipeline to identify
 * where highlighting breaks in the VS Code extension.
 *
 * Key findings:
 * - The Shiki worker uses a CSS-variable-based theme (`openchamber-md`)
 * - Token colors reference `var(--md-syntax-keyword)` etc.
 * - The `--md-syntax-*` CSS vars are extracted from the current Theme object
 *   by getMarkdownSyntaxVars() and set as inline styles on the container
 * - In VS Code, the theme is built by buildVSCodeThemeFromPalette()
 *   which reads VS Code CSS vars and maps them to OpenChamber's Theme shape
 *
 * Suspected failure points (in order of likelihood):
 *
 * 1. **Shiki worker failure in VS Code webview**: The worker URL
 *    (`./markdown-shiki-worker-[hash].js`) is resolved at runtime relative to
 *    the main script. If `localResourceRoots` does not include the worker
 *    chunk, or if the CSP blocks module workers, the worker creation fails
 *    and `getWorker()` returns `undefined`. This causes `highlightCodeInWorker`
 *    to return `null`, and the code block renders as plain (unhighlighted) text.
 *
 * 2. **CSS variable definition timing**: The `--md-syntax-*` variables are set
 *    in a `useEffect` (layout effect for first paint, then effect for async
 *    updates). If the theme is not yet available (e.g., the VS Code theme
 *    event hasn't fired yet), the syntax vars would use default theme colors.
 *    But the fallback default theme DOES have proper syntax colors, so this
 *    should still work.
 *
 * 3. **VS Code terminal ANSI colors are not distinctive**: Some VS Code themes
 *    set terminal ANSI colors to similar muted shades, making all syntax tokens
 *    appear as similar gray tones. The adapter maps:
 *    - keyword -> terminal.ansiBlue
 *    - string  -> textPreformat.foreground / terminal.ansiGreen
 *    - number  -> terminal.ansiYellow
 *    - function -> terminal.ansiCyan
 *    - type    -> terminal.ansiYellow (same as number!)
 *
 * 4. **CSS inheritance issue**: The `.markdown-content [data-markdown="code-block-body"]`
 *    rule sets `color: var(--shiki-light, inherit)`. If `--shiki-light` is not
 *    set, the fallback `inherit` makes the color cascade from the parent.
 *    Shiki's inline `color:var(--md-syntax-*)` should override this, but if
 *    `--md-syntax-*` doesn't resolve (undefined CSS variable), the element
 *    inherits the gray parent color.
 */

// ====================================================================
// 1. Verify the Shiki worker can be created and can tokenize code
// ====================================================================

import { bundledLanguages, createHighlighter, type BundledLanguage } from 'shiki';
import { MARKDOWN_SHIKI_THEME_DEFINITION, MARKDOWN_SHIKI_THEME } from 
  '../../packages/ui/src/components/chat/markdown/markdownShikiThemeDefinition';

async function testShikiWorker() {
  try {
    const highlighter = await createHighlighter({
      themes: [MARKDOWN_SHIKI_THEME_DEFINITION as any],
      langs: [],
    });

    // Load a language
    await highlighter.loadLanguage(bundledLanguages['typescript' as BundledLanguage]);

    // Tokenize code
    const html = highlighter.codeToHtml('const x: number = 42;', {
      lang: 'typescript',
      theme: MARKDOWN_SHIKI_THEME,
      tabindex: false,
    });

    console.log('Shiki output:');
    console.log(html);

    // Check if the output contains CSS variable references
    if (html.includes('var(--md-syntax-')) {
      console.log('✓ Output uses CSS variable theme (var(--md-syntax-*))');
    } else {
      console.log('✗ Output does NOT use CSS variable theme');
    }

    // Check for keyword highlighting
    if (html.includes('--md-syntax-keyword') || html.includes('--md-syntax-type')) {
      console.log('✓ Syntax tokens are distinguished with different CSS variables');
    } else {
      console.log('✗ No syntax token differentiation found');
    }

    return html;
  } catch (error) {
    console.error('Shiki test failed:', error);
    return null;
  }
}

// ====================================================================
// 2. Test getMarkdownSyntaxVars with different themes
// ====================================================================

import { getMarkdownSyntaxVars } from 
  '../../packages/ui/src/components/chat/markdown/markdownTheme';
import { getDefaultTheme } from '../../packages/ui/src/lib/theme/themes';

function testMarkdownSyntaxVars() {
  const lightTheme = getDefaultTheme(false);
  const darkTheme = getDefaultTheme(true);

  const lightVars = getMarkdownSyntaxVars(lightTheme);
  const darkVars = getMarkdownSyntaxVars(darkTheme);

  console.log('\nLight theme syntax vars:');
  for (const [key, value] of Object.entries(lightVars)) {
    console.log(`  ${key}: ${value}`);
  }

  console.log('\nDark theme syntax vars:');
  for (const [key, value] of Object.entries(darkVars)) {
    console.log(`  ${key}: ${value}`);
  }

  // Check that syntax colors are distinct
  const lightValues = Object.values(lightVars);
  const uniqueLight = new Set(lightValues);
  if (uniqueLight.size === lightValues.length) {
    console.log('✓ Light theme: All syntax CSS variables have unique values');
  } else {
    const duplicates = lightValues.filter((v, i, a) => a.indexOf(v) !== i);
    console.log(`⚠ Light theme: ${duplicates.length} duplicate values found: ${[...new Set(duplicates)].join(', ')}`);
  }

  const darkValues = Object.values(darkVars);
  const uniqueDark = new Set(darkValues);
  if (uniqueDark.size === darkValues.length) {
    console.log('✓ Dark theme: All syntax CSS variables have unique values');
  } else {
    const duplicates = darkValues.filter((v, i, a) => a.indexOf(v) !== i);
    console.log(`⚠ Dark theme: ${duplicates.length} duplicate values found: ${[...new Set(duplicates)].join(', ')}`);
  }
}

// ====================================================================
// 3. Test the VS Code theme adapter with mock VS Code CSS variables
// ====================================================================

import { buildVSCodeThemeFromPalette, type VSCodeThemePalette } from 
  '../../packages/ui/src/lib/theme/vscode/adapter';

function testVSCodeAdapter() {
  // Simulate a typical dark VS Code theme palette
  const mockPalette: VSCodeThemePalette = {
    kind: 'dark',
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'editor.selectionBackground': '#264f78',
      'editorCursor.foreground': '#aeafad',
      'interactive-session.foreground': '#d4d4d4',
      'chat.list.background': '#252526',
      'foreground': '#cccccc',
      'editorLineNumber.foreground': '#858585',
      'terminal.ansiBlue': '#569cd6',
      'terminal.ansiGreen': '#6a9955',
      'terminal.ansiYellow': '#dcdcaa',
      'terminal.ansiCyan': '#4ec9b0',
      'terminal.ansiMagenta': '#c586c0',
      'terminal.ansiRed': '#f44747',
      'textPreformat.foreground': '#ce9178',
      'descriptionForeground': '#808080',
      'button.background': '#0e639c',
      'button.foreground': '#ffffff',
      'focusBorder': '#007fd4',
      'widget.border': '#303031',
      'input.background': '#3c3c3c',
      'input.foreground': '#cccccc',
      'list.hoverBackground': '#2a2d2e',
      'list.activeSelectionBackground': '#094771',
      'list.activeSelectionForeground': '#ffffff',
      'scrollbarSlider.background': '#424242',
      'scrollbarSlider.hoverBackground': '#555555',
    },
    mode: 'dark',
  };

  const theme = buildVSCodeThemeFromPalette(mockPalette);
  
  console.log('\nVS Code adapted theme syntax colors:');
  const base = theme.colors.syntax.base;
  for (const [key, value] of Object.entries(base)) {
    console.log(`  syntax.base.${key}: ${value}`);
  }

  const syntaxVars = getMarkdownSyntaxVars(theme);
  
  console.log('\n--md-syntax-* CSS variables:');
  for (const [key, value] of Object.entries(syntaxVars)) {
    console.log(`  ${key}: ${value}`);
  }

  // Check for duplicate values
  const values = Object.values(syntaxVars);
  const unique = new Set(values);
  if (unique.size === values.length) {
    console.log('✓ All syntax CSS variables have unique values');
  } else {
    const dupes = [...new Set(values.filter((v, i, a) => a.indexOf(v) !== i))];
    console.log(`✗ Duplicate values found: ${dupes.join(', ')}`);
    console.log('  This means some syntax tokens will appear the same color!');
    console.log('  Number and type both map to terminal.ansiYellow in the adapter');
  }

  // Critical check: is foreground a valid color?
  if (base.foreground && base.foreground !== 'transparent') {
    console.log(`✓ syntax.base.foreground = ${base.foreground} (valid base color)`);
  } else {
    console.log(`✗ syntax.base.foreground = ${base.foreground} (might not be a valid color)`);
  }
}

// ====================================================================
// 4. Check the CSS code block color cascade issue
// ====================================================================

function analyzeCSSInheritance() {
  console.log('\n--- CSS Inheritance Analysis ---');
  console.log('The CSS rule at index.css:1155:');
  console.log('  .markdown-content [data-markdown="code-block-body"] {');
  console.log('    color: var(--shiki-light, inherit);');
  console.log('  }');
  console.log('');
  console.log('If --shiki-light is NOT defined, this resolves to:');
  console.log('  color: inherit;');
  console.log('');
  console.log('The Shiki worker produces:');
  console.log('  <pre style="color:var(--md-syntax-foreground)">');
  console.log('    <code>');
  console.log('      <span style="color:var(--md-syntax-keyword)">if</span>');
  console.log('    </code>');
  console.log('  </pre>');
  console.log('');
  console.log('If --md-syntax-keyword is undefined, the span\'s color');
  console.log('property is invalid, and the browser falls back to');
  console.log('the inherited color (gray foreground from parent).');
  console.log('');
  console.log('RISK: If the --md-syntax-* CSS variables are not applied');
  console.log('on the markdown container (due to timing or the target');
  console.log('element not existing), ALL code text would appear');
  console.log('in the inherited foreground color (gray).');
}

// ====================================================================
// Run all tests
// ====================================================================

async function main() {
  console.log('=== Reproduction: Syntax Highlight Issue #2047 ===\n');
  
  console.log('## 1. Shiki Worker Test');
  console.log('(This test needs to run in a browser/worker context -');
  console.log(' skipping in Node.js)\n');

  console.log('## 2. Markdown Syntax Vars Test');
  testMarkdownSyntaxVars();
  console.log();

  console.log('## 3. VS Code Adapter Test');
  testVSCodeAdapter();
  console.log();

  console.log('## 4. CSS Inheritance Analysis');
  analyzeCSSInheritance();
  console.log();

  console.log('=== Summary ===');
  console.log('Most likely root cause for "full gray text block":');
  console.log('');
  console.log('1. The Shiki worker may fail to load in the VS Code webview');
  console.log('   (worker URL resolution, CSP, or localResourceRoots issue),');
  console.log('   causing ALL code blocks to render as plain (unhighlighted) text.');
  console.log('');
  console.log('2. The --md-syntax-* CSS variables might not be applied to the');
  console.log('   markdown container. Without these, Shiki\'s inline');
  console.log('   var(--md-syntax-*) references cannot resolve to actual colors,');
  console.log('   and the browser falls back to the inherited gray foreground.');
  console.log('');
  console.log('3. Terminal ANSI color mapping in the VS Code adapter:');
  console.log('   syntaxNumber and syntaxType both use terminal.ansiYellow,');
  console.log('   meaning numbers and types get the same color. While this alone');
  console.log('   would not cause the "full gray" issue, it reduces color variety.');
  console.log('');
  console.log('Recommended fix approach:');
  console.log('- Verify Worker URL resolution in VS Code webview environment');
  console.log('- Add explicit --shiki-light CSS variable fallback path');
  console.log('- Ensure the syntax vars effect targets the right container');
  console.log('- Consider mapping syntaxType to terminal.ansiCyan (function)');
  console.log('  or adding a dedicated color instead of sharing with number');
}

main().catch(console.error);
