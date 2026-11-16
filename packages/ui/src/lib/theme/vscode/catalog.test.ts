import { describe, expect, test } from 'bun:test';
import { withoutRepeatedPalettes } from './catalog';
import { importVSCodeTheme } from './import';

const theme = (name: string, keyword: string, fontStyle: string) => JSON.stringify({
  name,
  type: 'dark',
  colors: { 'editor.background': '#1e2127', 'editor.foreground': '#abb2bf' },
  tokenColors: [{ scope: 'keyword', settings: { foreground: keyword, fontStyle } }],
});

const ready = (name: string, keyword: string, fontStyle = '') => ({
  status: 'ready' as const,
  name,
  definition: importVSCodeTheme(theme(name, keyword, fontStyle), `${name}.json`),
});

describe('theme package variants', () => {
  test('drops italic and bold editions that import to the same colors', () => {
    const variants = [
      ready('Eva Dark', '#c678dd'),
      ready('Eva Dark Bold', '#c678dd', 'bold'),
      ready('Eva Dark Italic', '#c678dd', 'italic'),
      { status: 'invalid' as const, name: 'Broken' },
      ready('Eva Dark Vivid', '#ff00ff'),
    ];
    expect(withoutRepeatedPalettes(variants).map((variant) => variant.name)).toEqual(['Eva Dark', 'Broken', 'Eva Dark Vivid']);
  });

  test('drops an edition named only by its font style even when one color differs', () => {
    const variants = [
      ready('Night Owl', '#c792ea'),
      ready('Night Owl (No Italics)', '#c792eb'),
      ready('Night Owl Bold', '#c792ec'),
      ready('Boldly Lit', '#123456'),
    ];
    expect(withoutRepeatedPalettes(variants).map((variant) => variant.name)).toEqual(['Night Owl', 'Boldly Lit']);
  });
});
