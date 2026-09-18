import type { Theme } from '@/types/theme';
import { chromaticDistance, contrastRatio, mixColor, onColor, readableText, rotateColorHue, withOpacity } from '../color';

const MIN_ACCENT_SEPARATION = 0.075;

/** Imported button fills are not necessarily usable as app-wide accents.
 * Adapt only the UI roles; syntax/diff colors still describe the source theme. */
export function adaptImportedRoles(theme: Theme, authored: Readonly<Record<string, string>>, syntax: Theme['colors']['syntax']['base']): void {
  const { surface, primary, status, interactive } = theme.colors;
  const canvas = surface.background;
  const dark = theme.metadata.variant === 'dark';
  const neutral = onColor(surface.muted, canvas);
  const surfaces = [canvas, surface.muted, surface.elevated, mixColor(interactive.selection, surface.muted, 1, canvas)]
    .filter((background) => onColor(background, canvas) === neutral);
  const readable = (seed: string) => surfaces.reduce((color, background) => readableText(color, background, canvas), seed);
  const paintedAccent = (color: string) => [canvas, surface.muted].every((background) => (contrastRatio(color, background, canvas) ?? 0) >= 3);

  const accents = [
    authored['button.background'], authored['textLink.foreground'],
    authored['activityBarBadge.background'], authored['list.highlightForeground'],
    authored.focusBorder, authored['inputOption.activeBorder'], syntax.function, syntax.keyword,
  ].filter((color) => color !== undefined);
  const nextPrimary = readable(accents.find(paintedAccent) ?? primary.base);
  if (nextPrimary !== primary.base) {
    primary.base = nextPrimary;
    primary.foreground = onColor(nextPrimary, canvas);
    primary.hover = mixColor(surface.foreground, nextPrimary, 0.08, canvas);
    primary.active = mixColor(surface.foreground, nextPrimary, 0.16, canvas);
    primary.muted = withOpacity(nextPrimary, 0.5);
    if (!authored.focusBorder && !authored['inputOption.activeBorder']) {
      interactive.focus = nextPrimary;
      interactive.focusRing = nextPrimary;
      interactive.borderFocus = nextPrimary;
    }
    if (theme.colors.markdown) {
      if (!authored['textLink.foreground']) theme.colors.markdown.link = nextPrimary;
      if (!authored['textLink.activeForeground']) theme.colors.markdown.linkHover = primary.hover;
      theme.colors.markdown.listMarker = withOpacity(nextPrimary, 0.6);
    }
  }
  if (surfaces.some((background) => (contrastRatio(interactive.focusRing, background, canvas) ?? 0) < 1.1)) {
    interactive.focus = primary.base;
    interactive.focusRing = primary.base;
    interactive.borderFocus = primary.base;
  }

  const separate = (color: string, other: string, minimum: number) => surfaces.every((background) =>
    (chromaticDistance(color, other, background, canvas) ?? 0) >= minimum);
  let nextInfo = readable(status.info);
  if (!separate(nextInfo, primary.base, MIN_ACCENT_SEPARATION)) {
    const acceptable = (color: string) => separate(color, primary.base, MIN_ACCENT_SEPARATION)
      && [status.error, status.warning, status.success].every((other) => separate(color, other, 0.1));
    const candidates = [
      authored['notificationsInfoIcon.foreground'], authored['editorInfo.foreground'],
      authored['terminal.ansiCyan'], authored['terminal.ansiBlue'], authored['terminal.ansiMagenta'],
      authored['textLink.foreground'], syntax.function, syntax.type,
    ].filter((color) => color !== undefined).map(readable);
    let info = candidates.find(acceptable);
    if (!info) {
      const seed = mixColor(nextInfo, canvas, 1, canvas);
      const seeds = [seed, readable(mixColor(seed, canvas, 0.5, canvas))];
      const rotated = seeds.flatMap((value) => [0.12, 0.18].flatMap((chroma) => [0, 60, -60, 90, -90, 120, -120, 180]
        .map((angle) => readable(rotateColorHue(value, angle, chroma)))));
      info = rotated.find(acceptable);
      // A dense palette can occupy every hue. Keep primary/info distinct first,
      // then maximize distance from the remaining status roles.
      if (!info) {
        const score = (color: string) => Math.min(...[status.error, status.warning, status.success]
          .map((other) => chromaticDistance(color, other, surface.muted, canvas) ?? 0));
        info = rotated.filter((color) => separate(color, primary.base, MIN_ACCENT_SEPARATION))
          .sort((a, b) => score(b) - score(a))[0];
      }
    }
    if (info) nextInfo = info;
  }
  if (nextInfo !== status.info) {
    status.info = nextInfo;
    status.infoForeground = onColor(nextInfo, canvas);
    status.infoBackground = withOpacity(nextInfo, dark ? 0.16 : 0.12);
    status.infoBorder = withOpacity(nextInfo, dark ? 0.45 : 0.35);
  }

  if (theme.colors.chat) {
    const current = theme.colors.chat.userMessageBackground ?? surface.elevated;
    if ((contrastRatio(current, canvas, canvas) ?? 1) < 1.1) {
      const painted = mixColor(current, canvas, 1, canvas);
      const darker = (contrastRatio(painted, '#000000') ?? 1) < (contrastRatio(canvas, '#000000') ?? 1);
      let target = darker ? '#000000' : '#ffffff';
      let start = painted;
      if ((contrastRatio(target, canvas, canvas) ?? 1) < 1.1 || (contrastRatio(painted, canvas, canvas) ?? 1) < 1.01) {
        start = canvas;
        target = surface.foreground;
      }
      let low = 0, high = 1;
      for (let step = 0; step < 16; step++) {
        const amount = (low + high) / 2;
        const candidate = mixColor(target, start, amount, canvas);
        if ((contrastRatio(candidate, canvas, canvas) ?? 1) >= 1.1) high = amount;
        else low = amount;
      }
      const background = mixColor(target, start, high, canvas);
      if ((contrastRatio(surface.foreground, background, canvas) ?? 0) >= 4.5) {
        theme.colors.chat.userMessageBackground = background;
      }
    }
  }
}
