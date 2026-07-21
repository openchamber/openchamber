// ghostty-web 0.4.0 leaves recycled rows dirty after default SGR resets (#138).
// Keep the theme background explicit until a stable release includes the upstream WASM fix.
const DEFAULT_BACKGROUND_RESETS = ['\u001b[0m', '\u001b[m'] as const;

const parseCssRgb = (color: string): [number, number, number] | null => {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    const expanded = hex.length <= 4
      ? hex.slice(0, 3).split('').map((part) => part + part).join('')
      : hex.slice(0, 6);
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    ];
  }

  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+)?\s*\)$/i.exec(value);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some((channel) => channel < 0 || channel > 255)) return null;
  return channels as [number, number, number];
};

export const getGhosttySafeResetSequence = (background: string): string | null => {
  const rgb = parseCssRgb(background);
  return rgb ? `\u001b[0;48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : null;
};

export const rewriteGhosttyDefaultBackgroundResets = (
  data: string,
  carry: string,
  safeReset: string | null,
): { data: string; carry: string } => {
  const combined = carry + data;
  if (!safeReset) return { data: combined, carry: '' };

  let carryLength = 0;
  const maxPrefixLength = Math.max(...DEFAULT_BACKGROUND_RESETS.map((reset) => reset.length)) - 1;
  for (let length = 1; length <= Math.min(maxPrefixLength, combined.length); length += 1) {
    const suffix = combined.slice(-length);
    if (DEFAULT_BACKGROUND_RESETS.some((reset) => reset.length > suffix.length && reset.startsWith(suffix))) {
      carryLength = length;
    }
  }

  const nextCarry = carryLength > 0 ? combined.slice(-carryLength) : '';
  let output = carryLength > 0 ? combined.slice(0, -carryLength) : combined;
  for (const reset of DEFAULT_BACKGROUND_RESETS) output = output.replaceAll(reset, safeReset);
  return { data: output, carry: nextCarry };
};
