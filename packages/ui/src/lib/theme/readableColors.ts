import type { Theme } from '../../types/theme';
import { mixColor, readableText } from './color';

/** Host-owned text colors shared by app CSS and extension snapshots. */
export function getReadableThemeColors(theme: Theme) {
  const { surface, primary, status, interactive } = theme.colors;
  const dark = theme.metadata.variant === 'dark';
  const tintedText = (seed: string, maximumTint: number) => {
    let text = seed;
    for (const background of [surface.background, surface.elevated, surface.muted]) {
      text = readableText(text, mixColor(seed, background, maximumTint, surface.background), surface.background);
    }
    return text;
  };
  return {
    tinted: {
      primary: tintedText(primary.base, dark ? 0.30 : 0.22),
      error: tintedText(status.error, dark ? 0.20 : 0.16),
      info: tintedText(status.info, 0.15),
      success: tintedText(status.success, 0.15),
      warning: tintedText(status.warning, 0.15),
    },
    status: {
      error: readableText(status.error, status.errorBackground, surface.background),
      warning: readableText(status.warning, status.warningBackground, surface.background),
      success: readableText(status.success, status.successBackground, surface.background),
      info: readableText(status.info, status.infoBackground, surface.background),
    },
    selectionForeground: readableText(interactive.selectionForeground, interactive.selection, surface.background),
  };
}
