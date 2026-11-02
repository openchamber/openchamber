// OpenChamber Canary's icons, all from its Icon Composer document
// (packages/electron/resources/icons-canary/AppIcon.icon): the release cube
// on a blue tile with a yellow canary at its side. The document is the
// master; its layers are art, not geometry, so this module works on the
// picture Icon Composer renders and needs Xcode 26 (ictool), like Assets.car.
//
// - Windows and Linux: the rendered icon cut out of its tile, cube and bird,
//   with the black outer outline of the release icon without a tile. The bird
//   stands in front of the outline. The .ico takes blue pixel cubes below
//   32 px, each with a round pixel chick (raster.mjs, PIXEL_BIRDS): the
//   slender bird does not read at taskbar and tray sizes.
// - macOS menu bar: the release glyph with the canary in pixel art at its lower
//   right, so the two apps are told apart when both run.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { GLYPH_UNSEEN_WALLS, MENU_BAR_GLYPH_ZOOM, glyphBreathRings, glyphSvg } from './geometry.mjs';
import { CANARY_PIXEL_COLORS, encodeIco, pixelCubePng, svgToPng } from './raster.mjs';

const SIZE = 1024;

// Where Icon Composer draws the cube in the rendered 1024 picture: its centre
// and the half-width of the shell's edge line, in px. One unit of geometry.mjs
// (cube half-width 41.568) is `UNIT` px there.
const CUBE = { cx: 512, cy: 508, halfWidth: 309 };
const UNIT = CUBE.halfWidth / 41.568;
// The outer outline of the release icon without a tile, in geometry units.
const OUTLINE_RADIUS = 44.27;
const OUTLINE_WIDTH = 3.1;
// The picture keeps what lies inside this hexagon (shell and glass), plus the bird.
const KEEP_RADIUS = 42.75;
// Without its tile the yellow bird had no edge on light backgrounds, so it gets
// a black outline like the cube's: its mask grown by this blur, in px.
const BIRD_OUTLINE_BLUR = 7;
// The square around the cube centre that becomes the icon; wide enough for the bird.
const CROP_HALF = 450;
const hexagonPoints = (radius) => {
  const w = radius * UNIT;
  const h = w * (2 / Math.sqrt(3));
  const { cx, cy } = CUBE;
  return [[cx, cy - h], [cx + w, cy - h / 2], [cx + w, cy + h / 2], [cx, cy + h], [cx - w, cy + h / 2], [cx - w, cy - h / 2]]
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
};

const svgSquare = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${inner}</svg>`);

const alphaOf = async (svg) => sharp(svg).ensureAlpha().extractChannel(3).raw().toBuffer();

/**
 * One channel, 255 where the rendered picture shows the bird's yellow. With
 * `grow` the mask spreads out by about `blur` px; without it the blur only
 * smooths the edge, which stays on the yellow.
 */
const birdMask = async (rgba, blur, { grow = false } = {}) => {
  const yellow = Buffer.alloc(SIZE * SIZE);
  for (let i = 0; i < yellow.length; i += 1) {
    const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    yellow[i] = r > 180 && g > 150 && b < 140 ? 255 : 0;
  }
  // sharp runs threshold before blur whatever the chain order, so the edge is
  // cut here, with a short ramp that keeps it smooth: low on the blur's tail to
  // grow, at its middle to stay on the yellow.
  const edge = grow ? 10 : 118;
  const blurred = await sharp(yellow, { raw: { width: SIZE, height: SIZE, channels: 1 } }).blur(blur).extractChannel(0).raw().toBuffer();
  return blurred.map((value) => Math.max(0, Math.min(255, (value - edge) * 12)));
};

const renderDocument = (documentPath, ictool) => {
  const tmp = mkdtempSync(join(tmpdir(), 'openchamber-canary-icon-'));
  try {
    const rendered = join(tmp, 'icon.png');
    execFileSync(ictool, [
      documentPath, '--export-image', '--output-file', rendered,
      '--platform', 'macOS', '--rendition', 'Default', '--width', String(SIZE), '--height', String(SIZE), '--scale', '1',
    ]);
    return readFileSync(rendered);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

/** The icon without a tile, 1024 px, from the rendered document. */
const noTileIcon = async (rendered) => {
  const rgba = await sharp(rendered).ensureAlpha().raw().toBuffer();
  const bird = await birdMask(rgba, 1.5);
  const hexagon = await alphaOf(svgSquare(`<polygon points="${hexagonPoints(KEEP_RADIUS)}" fill="#fff"/>`));
  const keep = Buffer.alloc(SIZE * SIZE);
  for (let i = 0; i < keep.length; i += 1) keep[i] = Math.max(hexagon[i], bird[i]);
  const rgb = await sharp(rendered).removeAlpha().raw().toBuffer();
  const cut = await sharp(rgb, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .joinChannel(keep, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .png()
    .toBuffer();
  const outline = svgSquare(`<polygon points="${hexagonPoints(OUTLINE_RADIUS)}" fill="none" stroke="#000" stroke-width="${(OUTLINE_WIDTH * UNIT).toFixed(1)}" stroke-linejoin="round"/>`);
  const birdOutline = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#000' } })
    .joinChannel(await birdMask(rgba, BIRD_OUTLINE_BLUR, { grow: true }), { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .png()
    .toBuffer();
  const full = await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: outline }, { input: birdOutline }, { input: cut }])
    .png()
    .toBuffer();
  return sharp(full)
    .extract({ left: CUBE.cx - CROP_HALF, top: CUBE.cy - CROP_HALF, width: CROP_HALF * 2, height: CROP_HALF * 2 })
    .resize(SIZE, SIZE)
    .png()
    .toBuffer();
};

/**
 * The menu bar bird: the app icon's canary redrawn per pixel for 36 and 18 px.
 * Scaled down by a resampler it lost its beak, its legs merged and half-covered
 * pixels turned it grey. K black, '.' clear; the eye and the wing stripe stay clear.
 */
const MENU_BAR_BIRDS = {
  36: [
    '..KKK...........',
    'KKK.KK..........',
    '.KKKKKK.........',
    '..KKKKK.........',
    '..KKKK..........',
    '.KKKK.KK........',
    '.KKK.KKK........',
    '.KK.KKKKK.......',
    '.KK.KKKKKK......',
    '.KK..KKKKKK.....',
    '..KK..KKKKK.....',
    '..KKK..KKKKK....',
    '...KKKK..KKK....',
    '....KKKKK..KK...',
    '......KKKKK.....',
    '.......KKKKKK...',
    '......K.K...KK..',
    '.....K.K....KK..',
    '...KKKKK.....KK.',
    '.............KK.',
    '..............KK',
  ],
  18: [
    '.KK.....',
    'K.KK....',
    '.KK.....',
    'KK.K....',
    'K.KKK...',
    '.K.KKK..',
    '..KKKK..',
    '...KKK..',
    '..K.K.K.',
    '.KKKK.K.',
    '.......K',
  ],
};

const menuBarBird = (size) => {
  const rows = MENU_BAR_BIRDS[size];
  const width = rows[0].length;
  const data = Buffer.alloc(width * rows.length * 4);
  rows.forEach((row, y) => [...row].forEach((cell, x) => { if (cell === 'K') data[(y * width + x) * 4 + 3] = 255; }));
  return sharp(data, { raw: { width, height: rows.length, channels: 4 } }).png().toBuffer();
};

/**
 * A menu bar template: the glyph at `size` with the bird standing over its
 * lower right corner. The picture grows to the right to make room. Black on
 * the glyph's grey walls did not read, so the bird cuts a clear gap of
 * `BIRD_GAP` of `size` out of the glyph around itself.
 */
const BIRD_GAP = 0.05;
const menuBarTemplate = async (glyphOptions, size) => {
  const glyph = await svgToPng(glyphSvg({ color: '#000000', zoom: MENU_BAR_GLYPH_ZOOM, ...glyphOptions }), size);
  const bird = await menuBarBird(size);
  const { width: birdWidth, height: birdHeight } = await sharp(bird).metadata();
  const width = size + Math.round(birdWidth * 0.35);
  const left = width - birdWidth;
  const top = size - birdHeight;
  const birdAlpha = await sharp({ create: { width, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: bird, left, top }])
    .extractChannel(3)
    .raw()
    .toBuffer();
  const grown = await sharp(birdAlpha, { raw: { width, height: size, channels: 1 } })
    .blur(Math.max(0.3, size * BIRD_GAP))
    .extractChannel(0)
    .raw()
    .toBuffer();
  const gap = Buffer.alloc(width * size * 4);
  for (let i = 0; i < grown.length; i += 1) gap[i * 4 + 3] = Math.max(0, Math.min(255, (grown[i] - 24) * 16));
  return sharp({ create: { width, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: glyph, left: 0, top: 0 },
      { input: gap, raw: { width, height: size, channels: 4 }, blend: 'dest-out' },
      { input: bird, left, top },
    ])
    .png()
    .toBuffer();
};

/** Every Canary image, keyed by path under `iconsDir`. */
export const canaryImageOutputs = async ({ iconsDir, releaseIconsDir, ictool }) => {
  const images = new Map();
  const rendered = renderDocument(join(iconsDir, 'AppIcon.icon'), ictool);

  const icon = await noTileIcon(rendered);
  const resized = (size) => sharp(icon).resize(size, size).png().toBuffer();
  images.set(join(iconsDir, 'icon.png'), icon);
  images.set(join(iconsDir, 'app-icon.png'), await resized(512));
  images.set(join(iconsDir, 'icon.ico'), encodeIco(await Promise.all([16, 20, 24, 32, 40, 48, 64, 128, 256].map(async (size) => ({
    size,
    png: size <= 24 ? await pixelCubePng(size, { colors: CANARY_PIXEL_COLORS, bird: true }) : await resized(size),
  })))));

  const states = [
    ['idle', {}],
    ['unseen', { walls: GLYPH_UNSEEN_WALLS }],
    ...[0, 3, 6, 9, 12, 15].map((i) => [`breath-${String(i).padStart(2, '0')}`, { rings: glyphBreathRings(i) }]),
  ];
  for (const [name, options] of states) {
    for (const size of [18, 36]) {
      images.set(join(iconsDir, 'tray', `trayTemplate-${name}${size === 36 ? '@2x' : ''}.png`), await menuBarTemplate(options, size));
    }
  }
  // The tray menu's session status icons are not the logo; Canary uses the release ones.
  const statusDir = join(releaseIconsDir, 'tray', 'status');
  for (const name of readdirSync(statusDir)) images.set(join(iconsDir, 'tray', 'status', name), readFileSync(join(statusDir, name)));
  return images;
};
