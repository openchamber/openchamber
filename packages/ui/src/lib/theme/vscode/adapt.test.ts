import { expect, test } from 'bun:test';
import { importVSCodeTheme } from './import';
import { buildVSCodeThemeFromPalette } from './adapter';
import { compactTheme, requireTheme } from '../definition';
import { colorHue, contrastRatio, withOpacity } from '../color';
import { getDefaultTheme } from '../themes';

test('live and imported palettes share UI policy, without mutating the source', () => {
  for (const type of ['dark', 'light'] as const) {
    const colors = {
      'editor.background': type === 'dark' ? '#111c18' : '#fff8e9',
      'editor.foreground': type === 'dark' ? '#ffffff' : '#000000',
      'editorWidget.background': type === 'dark' ? '#ffffff' : '#111111',
      'sideBar.background': type === 'dark' ? '#eeeeee' : '#ffffff',
      'button.background': '#2DD5B7', 'editorInfo.foreground': '#2DD5B7',
      'editorError.foreground': '#D2689C', 'editorWarning.foreground': '#ff0000',
      'testing.iconPassed': '#0000ff', 'widget.border': '#ff0000',
      'chat.requestBubbleBackground': '#ff00ff',
      'terminal.ansiMagenta': '#e0a98e',
    };
    const before = structuredClone(colors);
    const live = buildVSCodeThemeFromPalette({ kind: type, colors });
    const imported = requireTheme(importVSCodeTheme(JSON.stringify({ type, colors,
      semanticTokenColors: { function: '#268BD2', type: '#e0a98e' },
    }), 'fixture.json'));
    expect(colors).toEqual(before);
    for (const role of ['surface', 'primary', 'interactive', 'status', 'pr', 'chat', 'markdown'] as const) {
      expect(compactTheme(imported).colors[role]).toEqual(compactTheme(live).colors[role]);
    }
    expect(imported.colors.syntax.base.function).toBe('#268BD2');
    const c = live.colors;
    const surfaces = [c.surface.background, c.surface.muted, c.surface.elevated, c.chat?.userMessageBackground ?? ''];
    for (const background of surfaces) {
      expect(contrastRatio(c.surface.foreground, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.surface.mutedForeground, background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(c.surface.foreground, c.surface.background)).toBeGreaterThan(contrastRatio(c.surface.mutedForeground, c.surface.background)!);
    expect(contrastRatio(c.surface.muted, '#000000')).toBeLessThan(contrastRatio(c.surface.background, '#000000')!);
    expect(contrastRatio(c.surface.elevated, c.surface.background)).toBeLessThanOrEqual(1.1);
    expect(contrastRatio(c.chat?.userMessageBackground ?? '', c.surface.background)).toBeGreaterThanOrEqual(1.1);
    expect(contrastRatio(c.chat?.userMessageBackground ?? '', c.surface.background)).toBeLessThan(1.25);
    expect(contrastRatio(c.syntax.base.background, c.surface.background)).toBeLessThanOrEqual(1.1);
    for (const [color, low, high] of [
      [c.status.info, 230, 275], [c.status.success, 125, 165],
      [c.status.error, 10, 40], [c.status.warning, 65, 100],
      [c.pr?.merged ?? '', 285, 325], [c.pr?.blocked ?? '', 40, 65],
    ] as const) {
      expect(colorHue(color, c.surface.background)).toBeGreaterThanOrEqual(low);
      expect(colorHue(color, c.surface.background)).toBeLessThanOrEqual(high);
    }
    expect(c.pr?.draft).toBe(c.surface.mutedForeground);
    expect(c.status.infoBackground).toBe(withOpacity(c.status.info, type === 'dark' ? 0.16 : 0.12));
  }
});

test('a blue primary may share the info hue, and syntax remains authored', () => {
  const { colors } = requireTheme(importVSCodeTheme(JSON.stringify({ colors: {
    'editor.background': '#151313', 'editor.foreground': '#CECDC3',
    'button.background': '#5A96BC', 'editorInfo.foreground': '#5A96BC',
    'gitDecoration.modifiedResourceForeground': '#E8B04B',
  }, semanticTokenColors: { function: '#5A96BC' } }), 'blue.json'));
  expect(colors.status.info).toBe(colors.primary.base);
  expect(colors.syntax.base.function).toBe('#5A96BC');
  expect(colors.syntax.highlights?.diffModified).toBe('#E8B04B');
});

test('strong source selections become quiet fills with body-toned readable labels', () => {
  for (const kind of ['dark', 'light'] as const) {
    const { colors: c } = buildVSCodeThemeFromPalette({ kind, colors: {
      'editor.background': kind === 'dark' ? '#0a1611' : '#f8faf5',
      'editor.foreground': kind === 'dark' ? '#bcbfba' : '#393a34',
      'list.activeSelectionBackground': kind === 'dark' ? '#829285' : '#324235',
      'list.activeSelectionForeground': '#fafaf5',
    } });
    expect(contrastRatio(c.interactive.selection, c.surface.elevated, c.surface.background)).toBeLessThanOrEqual(1.5);
    expect(contrastRatio(c.interactive.selection, c.surface.elevated, c.surface.background)).toBeGreaterThan(1.1);
    expect(c.interactive.selectionForeground).not.toBe('#fafaf5');
    expect(contrastRatio(c.interactive.selectionForeground, c.interactive.selection, c.surface.background)).toBeGreaterThanOrEqual(4.5);
  }
});

test('inline code retains its source tint or uses a readable theme accent in both paths', () => {
  for (const kind of ['dark', 'light'] as const) {
    for (const inline of [undefined, kind === 'dark' ? '#dca0e8' : '#793488']) {
      const colors = {
        'editor.background': kind === 'dark' ? '#151313' : '#faf8f5',
        'editor.foreground': kind === 'dark' ? '#cccccc' : '#333333',
        'button.background': kind === 'dark' ? '#83afe0' : '#366eaa',
        'textPreformat.foreground': inline,
      };
      const live = buildVSCodeThemeFromPalette({ kind, colors });
      const imported = requireTheme(importVSCodeTheme(JSON.stringify({ type: kind, colors }), 'inline.json'));
      for (const theme of [live, imported]) {
        const c = theme.colors;
        const text = c.markdown?.inlineCode ?? '';
        expect(text).not.toBe(c.surface.foreground);
        if (inline) expect(text).toBe(inline);
        else {
          expect(colorHue(text, c.surface.background)).toBeGreaterThanOrEqual(230);
          expect(colorHue(text, c.surface.background)).toBeLessThanOrEqual(275);
        }
        expect(contrastRatio(text, c.markdown?.inlineCodeBackground ?? c.surface.background, c.surface.background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test('a low-contrast button fill uses a visible authored highlight', () => {
  const { colors } = requireTheme(importVSCodeTheme(JSON.stringify({ colors: {
    'editor.background': '#1f2126', 'editor.foreground': '#839496',
    'button.background': '#21252B', focusBorder: '#21252B',
    'list.highlightForeground': '#1ebcc5',
  } }), 'solarized.json'));
  expect(colors.primary.base).toBe('#1ebcc5');
  expect(colors.interactive.focusRing).toBe(colors.primary.base);
  expect(contrastRatio(colors.surface.foreground, colors.chat?.userMessageBackground ?? '')).toBeGreaterThanOrEqual(4.5);
});

test('high contrast light and dark keep authored surfaces, text, bubbles and outlines', () => {
  for (const type of ['hc-light', 'hc-black']) {
    const colors = {
      'editor.background': type === 'hc-light' ? '#ffffff' : '#000000',
      'editor.foreground': type === 'hc-light' ? '#000000' : '#ffffff',
      'sideBar.background': '#888888', 'editorWidget.background': '#456789',
      'chat.requestBubbleBackground': '#123456', contrastBorder: '#ff00ff',
    };
    const c = requireTheme(importVSCodeTheme(JSON.stringify({ type, colors }), 'hc.json')).colors;
    expect(c.surface.background).toBe(colors['editor.background']);
    expect(c.surface.foreground).toBe(colors['editor.foreground']);
    expect(c.surface.muted).toBe('#888888');
    expect(c.surface.elevated).toBe('#456789');
    expect(c.chat?.userMessageBackground).toBe('#123456');
    expect(c.interactive.border).toBe('#ff00ff');
  }
});

test('black canvases keep a black sidebar and readable neutral text', () => {
  const { colors } = buildVSCodeThemeFromPalette({ kind: 'dark', colors: {
    'editor.background': '#000000', 'editor.foreground': '#ffffff', 'sideBar.background': '#000000',
  } });
  expect(colors.surface.muted).toBe('#000000');
  expect(contrastRatio(colors.surface.foreground, colors.surface.background)).toBeLessThanOrEqual(10);
  expect(contrastRatio(colors.surface.mutedForeground, colors.surface.elevated)).toBeGreaterThanOrEqual(4.5);
});

test('mid-tone canvases favor readable text over surface separation', () => {
  for (const background of ['#757575', '#777777', '#808080']) {
    for (const kind of ['light', 'dark'] as const) {
      const { colors: c } = buildVSCodeThemeFromPalette({ kind, colors: { 'editor.background': background } });
      for (const bg of [c.surface.background, c.surface.muted, c.surface.elevated, c.chat?.userMessageBackground ?? '']) {
        expect(contrastRatio(c.surface.foreground, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.surface.mutedForeground, bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test('imported borders retain per-surface contrast limits with a small definition allowance', () => {
  for (const kind of ['dark', 'light'] as const) {
    const ink = kind === 'dark' ? '#ffffff' : '#000000';
    const reference = getDefaultTheme(kind === 'dark').colors;
    // Import budgets retain the approved baseline when the built-in theme is retuned.
    const referenceBorder = kind === 'dark' ? '#242323' : '#e5e1de';
    const referenceToolBorder = kind === 'dark' ? '#302e2b99' : '#d8d5d099';
    const { colors } = buildVSCodeThemeFromPalette({ kind, colors: {
      'editor.background': kind === 'dark' ? '#171d22' : '#f9f5ee',
      'widget.border': ink, 'toolbar.hoverOutline': ink,
      'chat.requestBorder': ink, 'textBlockQuote.border': ink,
    } });
    for (const role of ['background', 'muted', 'elevated'] as const) {
      for (const [actual, expected] of [
        [colors.interactive.border, referenceBorder],
        [colors.interactive.borderHover, reference.interactive.borderHover],
        [colors.tools?.border, referenceToolBorder],
        [colors.chat?.divider, reference.chat?.divider],
        [colors.markdown?.blockquoteBorder, reference.markdown?.blockquoteBorder],
      ]) {
        expect(actual).toBeDefined();
        expect(expected).toBeDefined();
        const referenceContrast = (background: string) => contrastRatio(expected ?? '', background, reference.surface.background) ?? 0;
        const limit = referenceContrast(reference.surface[role]);
        const strongest = Math.max(...[reference.surface.background, reference.surface.muted, reference.surface.elevated].map(referenceContrast));
        expect(contrastRatio(actual ?? '', colors.surface[role], colors.surface.background)).toBeLessThanOrEqual(
          limit + (strongest - limit) * 0.2 + 0.001,
        );
      }
    }
    const quiet = withOpacity(ink, 0.01);
    expect(buildVSCodeThemeFromPalette({ kind, colors: {
      'editor.background': colors.surface.background, 'widget.border': quiet,
    } }).colors.interactive.border).toBe(quiet);
  }
});
