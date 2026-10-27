import React from 'react';
import { ThemeProvider, type Theme, type TypographyTheme } from '@openuidev/react-ui/ThemeProvider';
import { useThemeSystem } from '@/contexts/useThemeSystem';

function readAppearance() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const rootSize = Number.parseFloat(style.fontSize) || 16;
  const pixels = (name: string, fallback: number) => {
    const value = read(name, `${fallback}rem`);
    return `${Number.parseFloat(value) * (value.endsWith('rem') ? rootSize : 1)}px`;
  };
  const family = read('--font-sans', 'sans-serif');
  const mono = read('--font-mono', 'monospace');
  const heading = read('--font-heading', family);
  const bodySize = pixels('--text-markdown', 0.875);
  const largeSize = `${Number.parseFloat(bodySize) * 1.125}px`;
  const scaled = (ratio: number) => `${Number.parseFloat(bodySize) * ratio}px`;
  const labelSize = pixels('--text-ui-label', 0.84375);
  const smallSize = pixels('--text-meta', 0.78125);
  const xsSize = pixels('--text-micro', 0.75);
  const codeSize = pixels('--text-code', 0.75);
  const bodyLine = read('--markdown-body-line-height', '1.6');
  const labelLine = read('--ui-label-line-height', '1.4');
  const codeLine = read('--code-block-line-height', '1.5');
  const bodySpacing = read('--markdown-body-letter-spacing', 'normal');
  const labelSpacing = read('--ui-label-letter-spacing', 'normal');
  const codeSpacing = read('--code-block-letter-spacing', 'normal');
  const font = (weight: number, size: string, line: 'body' | 'label' | 'code', fontFamily = family) => {
    const lineHeight = line === 'body' ? bodyLine : line === 'code' ? codeLine : labelLine;
    return `${weight} ${size}/${lineHeight} ${fontFamily}`;
  };
  const typography: TypographyTheme = {
    fontBody: family, fontLabel: family, fontHeading: heading, fontNumbers: family, fontCode: mono,
    fontSize2xs: xsSize, fontSizeXs: xsSize, fontSizeSm: smallSize, fontSizeMd: bodySize,
    fontSizeLg: largeSize, fontSizeXl: scaled(1.25), fontSize2xl: scaled(1.5), fontSize3xl: scaled(1.75),
    fontSize4xl: scaled(2), fontSize5xl: scaled(2.25),
    fontWeightRegular: '400', fontWeightMedium: '500', fontWeightBold: '600', fontWeightHeavy: '700',
    fontVariationRegular: 'normal', fontVariationMedium: 'normal',
    lineHeightBody: bodyLine, lineHeightHeading: labelLine, lineHeightHeadingLarge: labelLine, lineHeightLabel: labelLine, lineHeightCode: codeLine,
    letterSpacingNormal: bodySpacing, letterSpacingTight: labelSpacing, letterSpacingTighter: labelSpacing,
    textBodyXs: font(400, xsSize, 'body'), textBodyXsHeavy: font(600, xsSize, 'body'),
    textBodySm: font(400, smallSize, 'body'), textBodySmHeavy: font(600, smallSize, 'body'),
    textBodyDefault: font(400, bodySize, 'body'), textBodyDefaultHeavy: font(600, bodySize, 'body'),
    textBodyLg: font(400, largeSize, 'body'), textBodyLgHeavy: font(600, largeSize, 'body'),
    textHeadingXs: font(600, bodySize, 'label', heading), textHeadingSm: font(600, largeSize, 'label', heading),
    textHeadingMd: font(600, scaled(1.25), 'label', heading), textHeadingLg: font(600, scaled(1.5), 'label', heading),
    textHeadingXl: font(600, scaled(1.75), 'label', heading),
    textLabelXs: font(400, xsSize, 'label'), textLabelXsHeavy: font(600, xsSize, 'label'),
    textLabelSm: font(400, smallSize, 'label'), textLabelSmHeavy: font(600, smallSize, 'label'),
    textLabelDefault: font(400, labelSize, 'label'), textLabelDefaultHeavy: font(600, labelSize, 'label'),
    textLabelLg: font(400, labelSize, 'label'), textLabelLgHeavy: font(600, labelSize, 'label'),
    textNumbersXs: font(400, xsSize, 'label'), textNumbersXsHeavy: font(600, xsSize, 'label'),
    textNumbersSm: font(400, smallSize, 'label'), textNumbersSmHeavy: font(600, smallSize, 'label'),
    textNumbersDefault: font(400, bodySize, 'label'), textNumbersDefaultHeavy: font(600, bodySize, 'label'),
    textNumbersLg: font(400, largeSize, 'label'), textNumbersLgHeavy: font(600, largeSize, 'label'),
    textNumbersHeadingSm: font(600, largeSize, 'label'), textNumbersHeadingMd: font(600, scaled(1.25), 'label'),
    textNumbersHeadingLg: font(600, scaled(1.5), 'label'), textNumbersHeadingXl: font(600, scaled(1.75), 'label'),
    textCodeSm: font(400, codeSize, 'code', mono), textCodeSmHeavy: font(600, codeSize, 'code', mono),
    textCodeDefault: font(400, codeSize, 'code', mono), textCodeDefaultHeavy: font(600, codeSize, 'code', mono),
    textBodyXsLetterSpacing: bodySpacing, textBodyXsHeavyLetterSpacing: bodySpacing,
    textBodySmLetterSpacing: bodySpacing, textBodySmHeavyLetterSpacing: bodySpacing,
    textBodyDefaultLetterSpacing: bodySpacing, textBodyDefaultHeavyLetterSpacing: bodySpacing,
    textBodyLgLetterSpacing: bodySpacing, textBodyLgHeavyLetterSpacing: bodySpacing,
    textHeadingXsLetterSpacing: labelSpacing, textHeadingSmLetterSpacing: labelSpacing, textHeadingMdLetterSpacing: labelSpacing,
    textHeadingLgLetterSpacing: labelSpacing, textHeadingXlLetterSpacing: labelSpacing,
    textLabelXsLetterSpacing: labelSpacing, textLabelXsHeavyLetterSpacing: labelSpacing, textLabelSmLetterSpacing: labelSpacing, textLabelSmHeavyLetterSpacing: labelSpacing,
    textLabelDefaultLetterSpacing: labelSpacing, textLabelDefaultHeavyLetterSpacing: labelSpacing, textLabelLgLetterSpacing: labelSpacing, textLabelLgHeavyLetterSpacing: labelSpacing,
    textNumbersXsLetterSpacing: labelSpacing, textNumbersXsHeavyLetterSpacing: labelSpacing, textNumbersSmLetterSpacing: labelSpacing, textNumbersSmHeavyLetterSpacing: labelSpacing,
    textNumbersDefaultLetterSpacing: labelSpacing, textNumbersDefaultHeavyLetterSpacing: labelSpacing, textNumbersLgLetterSpacing: labelSpacing, textNumbersLgHeavyLetterSpacing: labelSpacing,
    textNumbersHeadingSmLetterSpacing: labelSpacing, textNumbersHeadingMdLetterSpacing: labelSpacing, textNumbersHeadingLgLetterSpacing: labelSpacing, textNumbersHeadingXlLetterSpacing: labelSpacing,
    textCodeSmLetterSpacing: codeSpacing, textCodeSmHeavyLetterSpacing: codeSpacing, textCodeDefaultLetterSpacing: codeSpacing, textCodeDefaultHeavyLetterSpacing: codeSpacing,
  };
  return { typography, palette: [1, 2, 3, 4, 5].map((index) => read(`--chart-${index}`, read('--primary', 'currentColor'))) };
}

let appearance: ReturnType<typeof readAppearance> | undefined;
const appearanceListeners = new Set<() => void>();
let stopAppearanceObserver: (() => void) | undefined;
const getAppearance = () => appearance ??= readAppearance();

function subscribeAppearance(listener: () => void) {
  appearanceListeners.add(listener);
  if (appearanceListeners.size === 1) {
    const refresh = () => {
      const next = readAppearance();
      if (JSON.stringify(appearance) === JSON.stringify(next)) return;
      appearance = next;
      for (const notify of appearanceListeners) notify();
    };
    // Font preferences and scale are written to the root. A font finishing its
    // download does not change these CSS values, so no font-loading hook is needed.
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    window.addEventListener('resize', refresh);
    stopAppearanceObserver = () => {
      observer.disconnect();
      window.removeEventListener('resize', refresh);
    };
    refresh();
  }
  return () => {
    appearanceListeners.delete(listener);
    if (appearanceListeners.size) return;
    stopAppearanceObserver?.();
    stopAppearanceObserver = undefined;
    appearance = undefined;
  };
}

export function OpenUITheme({ children, cssSelector }: { children: React.ReactNode; cssSelector: string }) {
  const { currentTheme } = useThemeSystem();
  const appearance = React.useSyncExternalStore(subscribeAppearance, getAppearance);
  const theme = React.useMemo<Theme>(() => {
    const { surface, primary, interactive, status, syntax } = currentTheme.colors;
    return {
      background: surface.background, foreground: surface.elevated, popoverBackground: surface.elevated,
      sunkLight: 'color-mix(in srgb, var(--foreground) 4%, transparent)',
      sunk: 'color-mix(in srgb, var(--foreground) 6%, transparent)',
      sunkDeep: 'color-mix(in srgb, var(--foreground) 8%, transparent)',
      elevatedLight: surface.subtle, elevated: surface.elevated, elevatedStrong: interactive.hover, elevatedIntense: interactive.active,
      overlay: surface.overlay, highlightSubtle: interactive.hover, highlight: interactive.selection,
      highlightStrong: interactive.active, highlightIntense: interactive.active, invertedBackground: surface.foreground,
      textNeutralPrimary: surface.foreground, textNeutralSecondary: surface.mutedForeground, textNeutralTertiary: surface.mutedForeground,
      textNeutralLink: 'var(--primary-text)', textBrand: 'var(--primary-text)', textWhite: primary.foreground, textBlack: surface.foreground,
      textAccentPrimary: 'var(--primary-text)', textAccentSecondary: 'var(--primary-text)', textAccentTertiary: 'var(--primary-text)',
      infoBackground: status.infoBackground, successBackground: status.successBackground, alertBackground: status.warningBackground, dangerBackground: status.errorBackground,
      purpleBackground: syntax.base.background, pinkBackground: syntax.base.background,
      textSuccessPrimary: 'var(--status-success-text)', textSuccessInverted: status.successForeground,
      textAlertPrimary: 'var(--status-warning-text)', textAlertInverted: status.warningForeground,
      textDangerPrimary: 'var(--status-error-text)', textDangerSecondary: 'var(--status-error-text)', textDangerTertiary: 'var(--status-error-text)',
      textDangerInvertedPrimary: status.errorForeground, textDangerInvertedSecondary: status.errorForeground, textDangerInvertedTertiary: status.errorForeground,
      textInfoPrimary: 'var(--status-info-text)', textInfoInverted: status.infoForeground,
      textPinkPrimary: syntax.base.string, textPinkInverted: syntax.base.foreground, textPurplePrimary: syntax.base.keyword, textPurpleInverted: syntax.base.foreground,
      interactiveAccentDefault: primary.base, interactiveAccentHover: primary.hover ?? primary.base,
      interactiveAccentPressed: primary.active ?? primary.base, interactiveAccentDisabled: surface.subtle,
      interactiveDestructiveDefault: status.errorBackground, interactiveDestructiveHover: interactive.hover,
      interactiveDestructivePressed: interactive.active, interactiveDestructiveDisabled: surface.subtle,
      interactiveDestructiveAccentDefault: status.error, interactiveDestructiveAccentHover: status.error,
      interactiveDestructiveAccentPressed: status.error, interactiveDestructiveAccentDisabled: surface.subtle,
      borderDefault: interactive.border, borderInteractive: interactive.borderHover, borderInteractiveEmphasis: interactive.borderFocus,
      borderInteractiveSelected: interactive.selection, borderAccent: primary.base, borderAccentEmphasis: primary.base,
      borderInfo: status.infoBorder, borderInfoEmphasis: status.info, borderAlert: status.warningBorder, borderAlertEmphasis: status.warning,
      borderSuccess: status.successBorder, borderSuccessEmphasis: status.success, borderDanger: status.errorBorder, borderDangerEmphasis: status.error,
      ...appearance.typography, defaultChartPalette: appearance.palette,
      space000: '0', space3xs: 'calc(0.125rem * var(--padding-scale, 1))', space2xs: 'calc(0.25rem * var(--padding-scale, 1))',
      spaceXs: 'calc(0.375rem * var(--padding-scale, 1))', spaceS: 'calc(0.5rem * var(--padding-scale, 1))', spaceSM: 'calc(0.625rem * var(--padding-scale, 1))',
      spaceM: 'calc(0.5rem * var(--padding-scale, 1))', spaceML: 'calc(0.625rem * var(--padding-scale, 1))', spaceL: 'calc(0.75rem * var(--padding-scale, 1))',
      spaceXl: 'calc(1.25rem * var(--padding-scale, 1))', space2xl: 'calc(1.5rem * var(--padding-scale, 1))', space3xl: 'calc(2rem * var(--padding-scale, 1))',
      radiusNone: '0', radiusXs: 'var(--radius)', radiusS: 'var(--radius)', radiusM: 'var(--radius)', radiusL: 'var(--radius)',
      radius3xs: 'var(--radius)', radius2xs: 'var(--radius)', radiusXl: 'var(--radius)', radius2xl: 'var(--radius)',
      radius3xl: 'var(--radius)', radius4xl: 'var(--radius)', radius5xl: 'var(--radius)', radius6xl: 'var(--radius)',
      radius7xl: 'var(--radius)', radius8xl: 'var(--radius)', radius9xl: 'var(--radius)', radiusFull: '9999px',
      shadow0: 'none',
      shadowS: '0 0.125rem 0.375rem color-mix(in srgb, var(--surface-overlay) 25%, transparent)',
      shadowM: '0 0.25rem 1rem color-mix(in srgb, var(--surface-overlay) 30%, transparent)',
      shadowL: '0 0.5rem 1.5rem color-mix(in srgb, var(--surface-overlay) 35%, transparent)',
      shadowXl: '0 0.75rem 2rem color-mix(in srgb, var(--surface-overlay) 40%, transparent)',
      shadow2xl: '0 1rem 2.5rem color-mix(in srgb, var(--surface-overlay) 45%, transparent)',
      shadow3xl: '0 1.25rem 3rem color-mix(in srgb, var(--surface-overlay) 50%, transparent)',
    };
  }, [currentTheme, appearance]);
  return (
    <ThemeProvider cssSelector={cssSelector} mode={currentTheme.metadata.variant} lightTheme={theme}>
      {children}
    </ThemeProvider>
  );
}
