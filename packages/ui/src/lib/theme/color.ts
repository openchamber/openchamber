type Color = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Color | null {
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value.trim())?.[1];
  if (hex) {
    const full = hex.length < 5 ? [...hex].map((c) => c + c).join('') : hex;
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value.trim());
  if (!rgb) return null;
  const r = Number(rgb[1]), g = Number(rgb[2]), b = Number(rgb[3]), a = rgb[4] === undefined ? 1 : Number(rgb[4]);
  return [r, g, b].every((c) => c >= 0 && c <= 255) && a >= 0 && a <= 1 ? { r, g, b, a } : null;
}

function over(front: Color, back: Color): Color {
  return { r: front.r * front.a + back.r * (1 - front.a), g: front.g * front.a + back.g * (1 - front.a), b: front.b * front.a + back.b * (1 - front.a), a: 1 };
}

function luminance(c: Color): number {
  const linear = (v: number) => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
  return linear(c.r) * 0.2126 + linear(c.g) * 0.7152 + linear(c.b) * 0.0722;
}

function ratio(a: Color, b: Color): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const hexColor = (c: Color): string => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Compose alpha before measuring; a tinted surface is not a solid status color. */
export function contrastRatio(foreground: string, background: string, canvas = '#ffffff'): number | null {
  const fg = parseColor(foreground), bg = parseColor(background), under = parseColor(canvas);
  if (!fg || !bg || !under) return null;
  const surface = over(bg, under);
  return ratio(over(fg, surface), surface);
}

/** Keep a readable author color; otherwise move it toward the readable neutral. */
export function readableText(foreground: string, background: string, canvas = '#ffffff'): string {
  const fg = parseColor(foreground), bg = parseColor(background), under = parseColor(canvas);
  // Legacy CSS colors outside hex/rgb remain valid CSS, but cannot be measured here.
  if (!fg || !bg || !under) return foreground;
  const surface = over(bg, under);
  if (ratio(over(fg, surface), surface) >= 4.5) return foreground;
  const black = { r: 0, g: 0, b: 0, a: 1 }, white = { r: 255, g: 255, b: 255, a: 1 };
  const target = ratio(black, surface) >= ratio(white, surface) ? black : white;
  let low = 0, high = 1, result = target;
  for (let step = 0; step < 16; step++) {
    const amount = (low + high) / 2;
    const candidate = { r: Math.round(fg.r + (target.r - fg.r) * amount), g: Math.round(fg.g + (target.g - fg.g) * amount), b: Math.round(fg.b + (target.b - fg.b) * amount), a: 1 };
    if (ratio(candidate, surface) >= 4.6) { result = candidate; high = amount; }
    else low = amount;
  }
  return hexColor(result);
}

export function onColor(background: string, canvas: string): string {
  const black = contrastRatio('#000000', background, canvas);
  const white = contrastRatio('#ffffff', background, canvas);
  return black !== null && white !== null && black >= white ? '#000000' : '#ffffff';
}

export function withOpacity(value: string, alpha: number): string {
  const color = parseColor(value);
  return color ? `${hexColor(color)}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` : `color-mix(in srgb, ${value} ${alpha * 100}%, transparent)`;
}

export function mixColor(foreground: string, background: string, amount: number, canvas = '#ffffff'): string {
  const fg = parseColor(foreground), bg = parseColor(background), under = parseColor(canvas);
  return fg && bg && under ? hexColor(over({ ...fg, a: fg.a * amount }, over(bg, under))) : `color-mix(in srgb, ${foreground} ${amount * 100}%, ${background})`;
}

function oklab(color: Color) {
  const linear = (value: number) => value / 255 <= 0.04045 ? value / 3294.6 : ((value / 255 + 0.055) / 1.055) ** 2.4;
  const r = linear(color.r), g = linear(color.g), b = linear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Perceptual hue/chroma separation after alpha composition; brightness alone
 * must not turn two nearly identical status hues into a distinct pair. */
export function chromaticDistance(first: string, second: string, background: string, canvas: string): number | null {
  const a = parseColor(first), b = parseColor(second), bg = parseColor(background), under = parseColor(canvas);
  if (!a || !b || !bg || !under) return null;
  const surface = over(bg, under);
  const x = oklab(over(a, surface)), y = oklab(over(b, surface));
  return Math.hypot(x.a - y.a, x.b - y.b);
}

/** Rotate a validated color in OKLCH while retaining lightness. A neutral seed
 * starts from blue when a caller requests chroma. Clamp to the sRGB gamut. */
export function rotateColorHue(value: string, degrees: number, minimumChroma = 0): string {
  const parsed = parseColor(value);
  if (!parsed) return value;
  const lab = oklab(parsed);
  const originalChroma = Math.hypot(lab.a, lab.b);
  const chroma = Math.max(originalChroma, minimumChroma);
  const hue = (originalChroma < 0.01 ? 250 * Math.PI / 180 : Math.atan2(lab.b, lab.a)) + degrees * Math.PI / 180;
  const a = chroma * Math.cos(hue), b = chroma * Math.sin(hue);
  const l = (lab.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lab.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lab.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (channel: number) => 255 * Math.max(0, Math.min(1, channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055));
  return hexColor({
    r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: 1,
  });
}
