// Adapted from T3 Code's libghostty-vt browser adapter (MIT, T3 Tools Inc.).
// See LICENSE-T3CODE in this directory.

const MONOSPACE_PROBE_VARIANTS = ['normal 400', 'normal 700', 'italic 400', 'italic 700'] as const;
const MONOSPACE_PROBE_GLYPHS = ['i', 'M', 'W', '0', '@', '#', '.', ' '] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;
// Generic keywords the canvas font shorthand parser does not accept in every
// engine (Chromium rejects ui-monospace outright, which silently voids the
// whole assignment). The concrete platform faces cover the same intent.
const UNSUPPORTED_CANVAS_GENERICS = /^(ui-monospace|ui-sans-serif|ui-serif|system-ui)$/i;

export function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return '';
  // Already quoted, or a single ident that needs no quoting.
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', '')}"`;
}

/**
 * Normalize a family list into a canvas-safe CSS font-family list, or null
 * when nothing usable remains. Quotes names the shorthand would reject and
 * drops generics that only some engines know.
 */
export function canvasFontFamilies(input: string): string | null {
  const families = input
    .split(',')
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0 && !UNSUPPORTED_CANVAS_GENERICS.test(name));
  return families.length > 0 ? families.join(', ') : null;
}

export function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (
    reference === undefined ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true;
  }
  return advances.every((advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE);
}

let fontProbeContext: CanvasRenderingContext2D | null | undefined;

/**
 * Whether a family renders every character on the same advance. The cell grid
 * requires this: a proportional face draws its text narrower than its own
 * cells and strands the cursor.
 */
export function isMonospaceFamily(family: string): boolean {
  const families = canvasFontFamilies(family);
  if (families === null) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement('canvas').getContext('2d');
    }
    if (fontProbeContext === null) return true;
    const context = fontProbeContext;
    // Fall back to a generic mono so an absent face measures as monospace and
    // is left for the normal fallback chain to resolve.
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width);
      if (!areFontAdvancesMonospace(advances)) return false;
    }
    return true;
  } catch {
    return true;
  }
}
