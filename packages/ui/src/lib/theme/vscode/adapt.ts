import type { Theme } from '@/types/theme';
import type { VSCodeThemePalette } from './adapter';
import { colorHue, contrastRatio, mixColor, onColor, readableText, withOpacity } from '../color';

// Both file imports and live VS Code palettes pass through this policy once.
export function adaptVSCodeRoles(theme: Theme, authored: Readonly<VSCodeThemePalette['colors']>, highContrast = false): void {
  if (highContrast) return;
  const { surface, primary, status, interactive, markdown, chat, tools, syntax } = theme.colors;
  const dark = theme.metadata.variant === 'dark';
  const canvas = surface.background;
  const neutral = onColor(canvas, canvas);
  const contrast = (color: string, background: string) => contrastRatio(color, background, canvas) ?? 1;

  // Search along a color pair, retaining the source hue instead of replacing
  // every palette with one shared gray. If a text floor is unattainable, the
  // readable neutral endpoint is the best available result.
  const toward = (seed: string, target: string, accepts: (color: string) => boolean) => {
    if (accepts(seed)) return seed;
    let low = 0, high = 1;
    let result = target;
    for (let step = 0; step < 16; step++) {
      const amount = (low + high) / 2;
      const candidate = mixColor(target, seed, amount, canvas);
      if (accepts(candidate)) { high = amount; result = candidate; }
      else low = amount;
    }
    return result;
  };
  const luminance = (color: string) => contrast(color, '#000000');
  const surfaceTextFloor = Math.min(4.6, contrast(neutral, canvas));
  const layer = (seed: string, lighter: boolean) => {
    const target = lighter ? '#ffffff' : '#000000';
    const correctDirection = lighter ? luminance(seed) > luminance(canvas) : luminance(seed) < luminance(canvas);
    const start = correctDirection ? mixColor(seed, canvas, 1, canvas) : canvas;
    const quiet = toward(start, canvas, (color) => contrast(color, canvas) <= 1.10);
    const separated = contrast(target, canvas) < 1.04
      ? target : toward(quiet, target, (color) => contrast(color, canvas) >= 1.04);
    // Mid-tone canvases have very little contrast headroom. Keep text readable
    // even when that leaves less room for separating the layers.
    return toward(separated, canvas, (color) => contrast(neutral, color) >= surfaceTextFloor);
  };
  surface.muted = layer(surface.muted, false);
  surface.elevated = layer(surface.elevated, dark);
  surface.subtle = mixColor(neutral, canvas, 0.025, canvas);
  const surfaces = [canvas, surface.muted, surface.elevated];
  const minimum = (color: string) => Math.min(...surfaces.map((background) => contrast(color, background)));
  const readable = (color: string) => toward(color, neutral, (candidate) => minimum(candidate) >= 4.6);
  const text = (seed: string, ceiling: number, floor = 4.6) => toward(
    toward(seed, canvas, (color) => contrast(color, canvas) <= ceiling),
    neutral, (color) => minimum(color) >= floor,
  );
  surface.foreground = text(surface.foreground, dark ? 10 : 9, 7);
  surface.mutedForeground = text(surface.mutedForeground, Math.min(6, contrast(surface.foreground, canvas) * 0.7));
  surface.elevatedForeground = text(surface.elevatedForeground, dark ? 10 : 9, 7);

  const accents = [authored['button.background'], authored['textLink.foreground'], authored['activityBarBadge.background'], authored['list.highlightForeground'], authored.focusBorder];
  primary.base = readable(accents.find((color) => color !== undefined && minimum(color) >= 3) ?? primary.base);
  primary.foreground = onColor(primary.base, canvas);
  primary.hover = mixColor(neutral, primary.base, 0.08, canvas);
  primary.active = mixColor(neutral, primary.base, 0.16, canvas);
  primary.muted = withOpacity(primary.base, 0.5);
  if (minimum(interactive.focusRing) < 1.1) {
    interactive.focus = primary.base;
    interactive.focusRing = primary.base;
    interactive.borderFocus = primary.base;
  }
  // Selection is a state, not a substitute for the sidebar surface.
  interactive.selection = toward(interactive.selection, mixColor(primary.base, canvas, 0.18, canvas), (color) => minimum(color) >= 1.1);
  interactive.selectionForeground = readableText(interactive.selectionForeground, interactive.selection, canvas);
  // Alpha must be measured over each surface, not flattened onto the canvas.
  const border = (seed: string, cap: number) => {
    if (surfaces.every((background) => contrast(seed, background) <= cap)) return seed;
    let low = 0, high = 1;
    let result = withOpacity(seed, 0);
    for (let step = 0; step < 16; step++) {
      const alpha = (low + high) / 2;
      const candidate = withOpacity(seed, alpha);
      if (surfaces.every((background) => contrast(candidate, background) <= cap)) { low = alpha; result = candidate; }
      else high = alpha;
    }
    return result;
  };
  interactive.border = border(interactive.border, dark ? 1.245 : 1.268);
  interactive.borderHover = border(interactive.borderHover, dark ? 2.356 : 1.64);
  interactive.hover = border(interactive.hover, 1.18);
  interactive.active = border(interactive.active, 1.25);

  // Semantic hue families stay stable even when the source diagnostics reuse
  // a brand accent. Shades within the family remain authored where possible.
  const semantic = (seed: string, fallback: string, low: number, high: number) => {
    const hue = colorHue(seed, canvas);
    return readable(hue !== null && hue >= low && hue <= high ? seed : fallback);
  };
  status.error = semantic(status.error, dark ? '#e07777' : '#b43b45', 10, 40);
  status.warning = semantic(status.warning, dark ? '#d6b467' : '#916b17', 65, 100);
  status.success = semantic(status.success, dark ? '#80b888' : '#357b47', 125, 165);
  status.info = semantic(status.info, dark ? '#83afe0' : '#366eaa', 230, 275);
  for (const role of ['error', 'warning', 'success', 'info'] as const) {
    status[`${role}Foreground`] = onColor(status[role], canvas);
    status[`${role}Background`] = withOpacity(status[role], dark ? 0.16 : 0.12);
    status[`${role}Border`] = withOpacity(status[role], dark ? 0.45 : 0.35);
  }
  theme.colors.pr = {
    open: status.success, closed: status.error, draft: surface.mutedForeground,
    blocked: semantic(authored['terminal.ansiYellow'] ?? '', dark ? '#d99464' : '#a65b25', 40, 65),
    merged: semantic(authored['terminal.ansiMagenta'] ?? '', dark ? '#b79bd9' : '#8255b0', 285, 325),
  };
  if (chat) {
    let base = toward(canvas, neutral, (color) => contrast(color, canvas) >= 1.12);
    if (contrast(neutral, base) < surfaceTextFloor) {
      base = toward(canvas, neutral === '#ffffff' ? '#000000' : '#ffffff', (color) => contrast(color, canvas) >= 1.12);
    }
    chat.userMessageBackground = toward(mixColor(primary.base, base, 0.03, canvas), base,
      (color) => contrast(color, canvas) >= 1.1 && contrast(neutral, color) >= surfaceTextFloor);
    surfaces.push(chat.userMessageBackground);
    surface.foreground = toward(surface.foreground, neutral, (color) => minimum(color) >= 7);
    surface.mutedForeground = readable(surface.mutedForeground);
    chat.userMessage = readableText(surface.foreground, chat.userMessageBackground, canvas);
    chat.assistantMessage = surface.foreground;
    chat.timestamp = surface.mutedForeground;
    chat.typing = surface.mutedForeground;
    chat.avatarForeground = authored['chat.avatarForeground'] ?? surface.foreground;
    chat.slashCommandBackground = authored['chat.slashCommandBackground'] ?? primary.base;
    chat.slashCommandForeground = authored['chat.slashCommandForeground'] ?? onColor(chat.slashCommandBackground, canvas);
    chat.inputWorkingBorderColor1 = authored['chat.inputWorkingBorderColor1'] ?? primary.base;
    chat.inputWorkingBorderColor2 = authored['chat.inputWorkingBorderColor2'] ?? primary.hover;
    chat.inputWorkingBorderColor3 = authored['chat.inputWorkingBorderColor3'] ?? primary.muted;
    chat.divider = border(chat.divider ?? interactive.border, dark ? 1.442 : 1.427);
  }
  if (theme.colors.pr) theme.colors.pr.draft = surface.mutedForeground;
  if (tools) {
    tools.border = border(tools.border ?? interactive.border, dark ? 1.207 : 1.231);
    tools.title = surface.foreground;
    tools.description = surface.mutedForeground;
    tools.icon = surface.mutedForeground;
  }
  if (markdown) {
    markdown.bold = mixColor(neutral, surface.foreground, 0.12, canvas);
    markdown.italic = surface.foreground;
    markdown.blockquote = surface.mutedForeground;
    markdown.blockquoteBorder = border(markdown.blockquoteBorder ?? interactive.border, dark ? 1.442 : 1.427);
    markdown.hr = border(markdown.hr ?? interactive.border, dark ? 1.442 : 1.427);
    markdown.link = readable(authored['textLink.foreground'] ?? primary.base);
    markdown.linkHover = readable(authored['textLink.activeForeground'] ?? primary.hover);
    markdown.listMarker = withOpacity(primary.base, 0.6);
    markdown.inlineCode = surface.foreground;
    markdown.inlineCodeBackground = surface.subtle;
  }
  syntax.base.background = toward(syntax.base.background, canvas, (color) => contrast(color, canvas) <= 1.1);
  syntax.base.foreground = readableText(surface.foreground, syntax.base.background, canvas);
}
