#!/usr/bin/env node
/**
 * harmonize-theme.mjs
 *
 * Aligns a theme's accent palette in OKLCH space so every accent shares one
 * saturation (chroma) and one brightness (lightness) target while keeping its
 * own hue. This is how you make colors borrowed from different themes feel like
 * one family — e.g. pulling Flexoki's punchy status hues down to Vitesse's
 * calmer saturation.
 *
 * It only touches the accent roles listed in ACCENT_ROLES (primary / status /
 * pr). Surfaces, borders, text, and syntax are left untouched — syntax is
 * usually already the reference you are matching to.
 *
 * Pipeline per color:  hex -> linear sRGB -> OKLab -> OKLCH
 *   -> set L = target.l, C = target.c, keep H
 *   -> gamut-fit (reduce C until it fits sRGB) -> hex (alpha preserved)
 *
 * Usage:
 *   node scripts/harmonize-theme.mjs <theme.json>              # dry-run table
 *   node scripts/harmonize-theme.mjs <theme.json> --write      # rewrite in place
 *   node scripts/harmonize-theme.mjs <theme.json> --out=x.json
 *   Overrides: --l=0.70 --c=0.085   (defaults are chosen per light/dark variant)
 *
 * No dependencies; math ported from the OpenCode desktop color engine.
 */
import fs from 'node:fs';

// ---- sRGB <-> OKLCH ---------------------------------------------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hue = (v) => ((v % 360) + 360) % 360;

function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  const a = h.length === 8 ? h.slice(6, 8) : null;
  const n = parseInt(h.slice(0, 6), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, alpha: a };
}
function toHex(r, g, b, alpha) {
  const c = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}${alpha ?? ''}`;
}
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function rgbToOklch(r, g, b) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l = Math.cbrt(l_), m = Math.cbrt(m_), s = Math.cbrt(s_);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let H = Math.atan2(bb, a) * (180 / Math.PI);
  if (H < 0) H += 360;
  return { l: L, c: Math.sqrt(a * a + bb * bb), h: H };
}
function oklchToRgb({ l: L, c: C, h: H }) {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  return {
    r: linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    g: linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    b: linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  };
}
const inGamut = ({ r, g, b }) => r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1;
function fitOklch(o) {
  const base = { l: clamp(o.l, 0, 1), c: Math.max(0, o.c), h: hue(o.h) };
  if (inGamut(oklchToRgb(base))) return base;
  let c = base.c;
  for (let i = 0; i < 24; i++) {
    c *= 0.9;
    const next = { ...base, c };
    if (inGamut(oklchToRgb(next))) return next;
  }
  return { ...base, c: 0 };
}
function oklchToHex(o, alpha) {
  const { r, g, b } = oklchToRgb(fitOklch(o));
  return toHex(r, g, b, alpha);
}

// ---- harmonization ----------------------------------------------------------
// Per variant: the single chroma (saturation) and lightness every accent lands
// on. Dark values match Vitesse Dark's calm accents (~L .68, C .085); light
// values match Vitesse Light (~L .55, C .10) and stay readable on white.
const TARGETS = {
  dark: { l: 0.68, c: 0.135 },
  light: { l: 0.55, c: 0.145 },
};

// Status accent roles to align. Each re-derives its translucent background,
// border, and on-fill text color from the harmonized base.
const STATUS_ROLES = ['error', 'warning', 'success', 'info'];
// pr accents that carry a hue (draft stays a neutral grey, so it is skipped).
const PR_ROLES = ['open', 'blocked', 'merged', 'closed'];
const STATUS_BG_ALPHA = '20';
const STATUS_BORDER_ALPHA = '50';
// Lightness offsets applied to the harmonized primary base to derive its
// interaction shades (dark themes lift on hover/press, light themes deepen).
const PRIMARY_OFFSETS = {
  dark: { hover: 0.05, active: 0.1, emphasis: 0.1 },
  light: { hover: -0.06, active: -0.11, emphasis: -0.06 },
};

function harmonize(hex, target) {
  const { r, g, b, alpha } = parseHex(hex);
  const src = rgbToOklch(r, g, b);
  const out = { l: target.l, c: target.c, h: src.h };
  return { hex: oklchToHex(out, alpha), src, out };
}
// shift a harmonized base to a new lightness, keeping chroma + hue
function atLightness(hex, l) {
  const { r, g, b } = parseHex(hex);
  const o = rgbToOklch(r, g, b);
  return oklchToHex({ l: clamp(l, 0, 1), c: o.c, h: o.h });
}
// pick #000 / #fff for text on a solid fill
function onColor(hex) {
  const { r, g, b } = parseHex(hex);
  const L = rgbToOklch(r, g, b).l;
  return L > 0.6 ? '#000000' : '#ffffff';
}
// multiply chroma by a factor, keeping lightness + hue (gamut-fit clamps the
// already-saturated ones, so pastels gain the most). Used to de-pastel syntax.
function scaleChroma(hex, factor) {
  const { r, g, b, alpha } = parseHex(hex);
  const src = rgbToOklch(r, g, b);
  const out = { l: src.l, c: src.c * factor, h: src.h };
  return { hex: oklchToHex(out, alpha), src, out };
}

// Syntax token colors are boosted, but not the code panel background, the
// default text color, or the deliberately-muted local-variable tone.
const SYNTAX_SKIP_BASE = new Set(['background', 'foreground']);
const SYNTAX_SKIP_TOKENS = new Set(['variableLocal']);

function saturateSyntax(theme, factor) {
  const syntax = theme.colors?.syntax;
  const rows = [];
  const bump = (bag, skip, prefix) => {
    if (!bag) return;
    for (const [key, val] of Object.entries(bag)) {
      if (typeof val !== 'string' || skip.has(key)) continue;
      const { hex, src, out } = scaleChroma(val, factor);
      bag[key] = hex;
      rows.push([`${prefix}.${key}`, val, hex, src, out]);
    }
  };
  bump(syntax?.base, SYNTAX_SKIP_BASE, 'base');
  bump(syntax?.tokens, SYNTAX_SKIP_TOKENS, 'tokens');
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error(
      'usage: node scripts/harmonize-theme.mjs <theme.json> [--write] [--out=path] [--l=..] [--c=..]\n' +
        '       node scripts/harmonize-theme.mjs <theme.json> --syntax[=factor] [--write]  (boost syntax saturation only)',
    );
    process.exit(1);
  }
  const write = args.includes('--write');
  const outArg = args.find((a) => a.startsWith('--out='));
  const lArg = args.find((a) => a.startsWith('--l='));
  const cArg = args.find((a) => a.startsWith('--c='));

  const theme = JSON.parse(fs.readFileSync(file, 'utf8'));
  const variant = theme.metadata?.variant === 'light' ? 'light' : 'dark';
  const target = { ...TARGETS[variant] };
  if (lArg) target.l = parseFloat(lArg.split('=')[1]);
  if (cArg) target.c = parseFloat(cArg.split('=')[1]);

  // --- syntax-only mode: boost token saturation, leave accents untouched ---
  const synArg = args.find((a) => a === '--syntax' || a.startsWith('--syntax='));
  if (synArg) {
    const factor = synArg.includes('=') ? parseFloat(synArg.split('=')[1]) : 1.3;
    const rows = saturateSyntax(theme, factor);
    console.log(`\n${file}  (syntax saturation ×${factor}, variant: ${variant})\n`);
    console.log('  token                before   ->  after     C (chroma)');
    for (const [name, before, after, src, out] of rows) {
      console.log(
        `  ${name.padEnd(20)} ${before.slice(0, 7)} -> ${after.slice(0, 7)}   ${src.c.toFixed(3)}→${out.c.toFixed(3)}`,
      );
    }
    const outPath = outArg ? outArg.split('=')[1] : file;
    if (write || outArg) {
      fs.writeFileSync(outPath, JSON.stringify(theme, null, 2) + '\n');
      console.log(`\nwrote ${outPath}`);
    } else {
      console.log('\n(dry run — pass --write to save)');
    }
    return;
  }

  const rows = [];
  const record = (name, before, after, src, out) => rows.push([name, before, after, src, out]);

  // --- primary: harmonize base, derive interaction shades from it ----------
  const primary = theme.colors?.primary;
  if (primary && typeof primary.base === 'string') {
    const { hex, src, out } = harmonize(primary.base, target);
    record('primary.base', primary.base, hex, src, out);
    primary.base = hex;
    const off = PRIMARY_OFFSETS[variant];
    if ('hover' in primary) primary.hover = atLightness(hex, target.l + off.hover);
    if ('active' in primary) primary.active = atLightness(hex, target.l + off.active);
    if ('emphasis' in primary) primary.emphasis = atLightness(hex, target.l + off.emphasis);
    if ('muted' in primary) primary.muted = hex.slice(0, 7) + '80';
    if ('foreground' in primary) primary.foreground = onColor(hex);

    // Wire the interactive focus/selection accent to the harmonized primary.
    const inter = theme.colors?.interactive;
    if (inter) {
      if ('borderFocus' in inter) inter.borderFocus = hex;
      if ('focus' in inter) inter.focus = hex;
      if ('focusRing' in inter) inter.focusRing = hex.slice(0, 7) + '55';
      if ('selection' in inter) inter.selection = hex.slice(0, 7) + '2b';
    }
  }

  // --- status: harmonize base, re-derive tints + on-fill text --------------
  const status = theme.colors?.status;
  if (status) {
    for (const key of STATUS_ROLES) {
      if (typeof status[key] !== 'string') continue;
      const { hex, src, out } = harmonize(status[key], target);
      record(`status.${key}`, status[key], hex, src, out);
      status[key] = hex;
      const bare = hex.slice(0, 7);
      if (`${key}Background` in status) status[`${key}Background`] = bare + STATUS_BG_ALPHA;
      if (`${key}Border` in status) status[`${key}Border`] = bare + STATUS_BORDER_ALPHA;
      if (`${key}Foreground` in status) status[`${key}Foreground`] = onColor(hex);
    }
  }

  // --- pr: harmonize the hued roles ----------------------------------------
  const pr = theme.colors?.pr;
  if (pr) {
    for (const key of PR_ROLES) {
      if (typeof pr[key] !== 'string') continue;
      const { hex, src, out } = harmonize(pr[key], target);
      record(`pr.${key}`, pr[key], hex, src, out);
      pr[key] = hex;
    }
  }

  console.log(`\n${file}  (variant: ${variant}, target L=${target.l} C=${target.c})\n`);
  console.log('  token                before   ->  after     ΔC (chroma)');
  for (const [name, before, after, src, out] of rows) {
    console.log(
      `  ${name.padEnd(20)} ${before.slice(0, 7)} -> ${after.slice(0, 7)}   ` +
        `${src.c.toFixed(3)}→${out.c.toFixed(3)}  L ${src.l.toFixed(2)}→${out.l.toFixed(2)}  H${Math.round(src.h)}`,
    );
  }

  const outPath = outArg ? outArg.split('=')[1] : file;
  if (write || outArg) {
    fs.writeFileSync(outPath, JSON.stringify(theme, null, 2) + '\n');
    console.log(`\nwrote ${outPath}`);
  } else {
    console.log('\n(dry run — pass --write to save, or --out=path)');
  }
}

main();
