// Turning the drawings in geometry.mjs into image files: PNG through sharp
// (librsvg), the pixel-exact tray cube, and Windows .ico containers.

import sharp from 'sharp';

/**
 * Renders an SVG string to a PNG buffer of `size` x `size`. The density makes
 * librsvg draw at the target size instead of scaling a bitmap of the SVG's own
 * width.
 */
export const svgToPng = (svg, size) => {
  const width = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1]);
  if (!width) throw new Error('SVG needs a numeric width to render');
  return sharp(Buffer.from(svg), { density: (72 * size) / width })
    .resize(size, size)
    .png()
    .toBuffer();
};

export const solidSquare = (size, background) => sharp({ create: { width: size, height: size, channels: 4, background } })
  .png()
  .toBuffer();

/**
 * Lays `png` over a square of `background` with `inset` px free on every side.
 * `round` is a corner radius in px, or 'circle'.
 */
export const composeOnSquare = async ({ png, size, background, inset = 0, round = null }) => {
  const inner = await sharp(png).resize(size - inset * 2, size - inset * 2).toBuffer();
  const base = round
    ? sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${round === 'circle'
      ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${background}"/>`
      : `<rect width="${size}" height="${size}" rx="${round}" fill="${background}"/>`}</svg>`))
    : sharp({ create: { width: size, height: size, channels: 4, background } });
  return base.composite([{ input: inner, left: inset, top: inset }]).png().toBuffer();
};

// ---------------------------------------------------------------------------
// Pixel-exact cube for 16-24 px (Windows .ico frames, favicon-16). Scaled-down
// vector art blurs there: the 30 degree edges fall between pixels. These use a
// 2:1 slope, so every edge is a clean two-pixel staircase, with no
// anti-aliasing and a 1 px black outline for light taskbars.

const PIXEL_COLORS = {
  leftWall: [0x45, 0x47, 0x4d],
  rightWall: [0x5a, 0x5c, 0x62],
  roof: [0x1d, 0x1e, 0x21],
  edge: [0xf5, 0xf5, 0xf7],
  outline: [0, 0, 0],
};

/** Tiers per size: [half-width in px (even), colour], outer to core. */
export const PIXEL_CUBES = {
  16: { halfWidth: 6, wallHeight: 7, tiers: [[4, [0xb8, 0xba, 0xc0]]] },
  20: { halfWidth: 8, wallHeight: 9, tiers: [[6, [0x78, 0x7a, 0x80]], [4, [0xd4, 0xd5, 0xd8]]] },
  24: { halfWidth: 10, wallHeight: 11, tiers: [[8, [0x78, 0x7a, 0x80]], [6, [0x9f, 0xa1, 0xa6]], [4, [0xd4, 0xd5, 0xd8]]] },
};

const createCanvas = (size) => {
  const data = new Uint8Array(size * size * 4);
  const inside = (x, y) => x >= 0 && y >= 0 && x < size && y < size;
  const set = (x, y, [r, g, b]) => {
    if (!inside(x, y)) return;
    const i = (y * size + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  const alpha = (x, y) => (inside(x, y) ? data[(y * size + x) * 4 + 3] : 0);
  return { data, set, alpha };
};

// Convex polygon on integer pixel coordinates: on each pixel row, every pixel
// from the left edge to the right edge, boundary pixels included.
const fillPolygon = (canvas, size, points, color) => {
  for (let y = 0; y < size; y += 1) {
    const xs = [];
    points.forEach(([xa, ya], i) => {
      const [xb, yb] = points[(i + 1) % points.length];
      if (y < Math.min(ya, yb) || y > Math.max(ya, yb)) return;
      if (ya === yb) xs.push(xa, xb);
      else xs.push(xa + ((xb - xa) * (y - ya)) / (yb - ya));
    });
    if (xs.length < 2) continue;
    for (let x = Math.ceil(Math.min(...xs)); x <= Math.floor(Math.max(...xs)); x += 1) canvas.set(x, y, color);
  }
};

// Bresenham from `a` to `b`, both ends included: each step along the longer
// axis moves the other coordinate once the error reaches zero, so a half-way
// pixel lands away from the start.
const drawLine = (canvas, [x0, y0], [x1, y1], color) => {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const xs = x1 < x0 ? -1 : 1;
  const ys = y1 < y0 ? -1 : 1;
  const [long, short] = dx >= dy ? [dx, dy] : [dy, dx];
  let x = x0;
  let y = y0;
  let e = 2 * short - long;
  for (let i = 0; i <= long; i += 1) {
    canvas.set(x, y, color);
    if (short && e >= 0) {
      if (dx >= dy) y += ys; else x += xs;
      e -= 2 * long;
    }
    e += 2 * short;
    if (dx >= dy) x += xs; else y += ys;
  }
};

/** Raw RGBA pixels of the pixel-exact cube at `size` (16, 20 or 24); `tape` for a development copy. */
export const pixelCube = (size, { tape = false } = {}) => {
  const spec = PIXEL_CUBES[size];
  if (!spec) throw new Error(`No pixel cube for ${size} px`);
  const { halfWidth: hw, wallHeight: h, tiers } = spec;
  const rise = hw / 2;
  const total = 2 * rise + h + 1;
  const y0 = Math.floor((size - total) / 2);
  const c = Math.floor(size / 2);
  const T = [c, y0];
  const L = [c - hw, y0 + rise];
  const F = [c, y0 + 2 * rise];
  const R = [c + hw, y0 + rise];
  const BL = [L[0], L[1] + h];
  const B = [F[0], F[1] + h];
  const BR = [R[0], R[1] + h];

  const art = createCanvas(size);
  fillPolygon(art, size, [L, F, B, BL], PIXEL_COLORS.leftWall);
  fillPolygon(art, size, [F, R, BR, B], PIXEL_COLORS.rightWall);
  fillPolygon(art, size, [T, R, F, L], PIXEL_COLORS.roof);
  const cy = y0 + rise;
  for (const [k, color] of tiers) {
    fillPolygon(art, size, [[c, cy - k / 2], [c + k, cy], [c, cy + k / 2], [c - k, cy]], color);
  }
  for (const [a, b] of [[T, L], [T, R], [L, F], [F, R], [L, BL], [R, BR], [BL, B], [B, BR], [F, B]]) {
    drawLine(art, a, b, PIXEL_COLORS.edge);
  }

  const out = createCanvas(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (art.alpha(x, y)) continue;
      if (art.alpha(x + 1, y) || art.alpha(x - 1, y) || art.alpha(x, y + 1) || art.alpha(x, y - 1)) {
        out.set(x, y, PIXEL_COLORS.outline);
      }
    }
  }
  for (let i = 0; i < art.data.length; i += 4) {
    if (art.data[i + 3]) out.data.set(art.data.subarray(i, i + 4), i);
  }
  if (tape) drawPixelTape(out, size);
  return out.data;
};

const TAPE_COLORS = { yellow: [0xd6, 0xa2, 0x3c], dark: [0x1b, 0x1b, 0x1b] };

// The development-copy tape across the lower cube, full width: two-pixel
// diagonal stripes, a quarter of the icon high.
const drawPixelTape = (canvas, size) => {
  const height = Math.round(size / 4);
  const top = Math.round(size * 0.6);
  for (let y = top; y < top + height; y += 1) {
    for (let x = 0; x < size; x += 1) {
      canvas.set(x, y, (x + y) % 4 < 2 ? TAPE_COLORS.yellow : TAPE_COLORS.dark);
    }
  }
};

export const pixelCubePng = (size, options) => sharp(Buffer.from(pixelCube(size, options)), { raw: { width: size, height: size, channels: 4 } })
  .png()
  .toBuffer();

// ---------------------------------------------------------------------------
// .ico with PNG-compressed entries (Windows Vista and later read them).

export const encodeIco = (entries) => {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2);
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map(({ png }) => png)]);
};
