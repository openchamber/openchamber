// OpenChamber Canary's icons, all from its Icon Composer document
// (packages/electron/resources/icons-canary/AppIcon.icon): the release cube
// on a violet tile with a yellow canary at its base. The document is the
// master; its layers are art, not geometry, so this module works on the
// picture Icon Composer renders and needs Xcode 26 (ictool), like Assets.car.
//
// - Windows and Linux: the rendered icon cut out of its tile, cube and bird,
//   with the black outer outline of the release icon without a tile. The bird
//   stands in front of the outline, and the violet is deeper and a touch
//   pinker than the tile's, or the cube looks pale. The .ico takes violet pixel cubes below
//   32 px, each with a round pixel chick (raster.mjs, PIXEL_BIRDS): the
//   slender bird does not read at taskbar and tray sizes.
// - macOS menu bar: the release glyph with the bird's silhouette at its lower
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
const CUBE = { cx: 511, cy: 506, halfWidth: 300 };
const UNIT = CUBE.halfWidth / 41.568;
// The outer outline of the release icon without a tile, in geometry units.
const OUTLINE_RADIUS = 44.27;
const OUTLINE_WIDTH = 3.1;
// The picture keeps what lies inside this hexagon (shell and glass), plus the bird.
const KEEP_RADIUS = 42.75;
// The square around the cube centre that becomes the icon; wide enough for the bird.
const CROP_HALF = 450;
// Without its tile the cube looked pale on Windows, so the icon without a tile
// deepens its violet: hue towards pink in degrees, saturation and lightness
// factors (Iuliia's pick on the ThinkPad screen, 2026-10-30).
const VIOLET_DEEPENING = { hue: 9, saturation: 1.3, lightness: 0.87 };

/** One RGB colour with its violet deepened by `VIOLET_DEEPENING`; every other colour as it was. */
const deepenViolet = ([r, g, b]) => {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  if (chroma < 0.05) return [r, g, b];
  let hue = max === red ? ((green - blue) / chroma) % 6 : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 220 || hue > 300) return [r, g, b];
  const lightness = ((max + min) / 2) * VIOLET_DEEPENING.lightness;
  const saturation = Math.min(1, (chroma / (1 - Math.abs(max + min - 1))) * VIOLET_DEEPENING.saturation);
  hue += VIOLET_DEEPENING.hue;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r1, g1, b1] = hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [r1, g1, b1].map((channel) => Math.round((channel + m) * 255));
};

const hexagonPoints = (radius) => {
  const w = radius * UNIT;
  const h = w * (2 / Math.sqrt(3));
  const { cx, cy } = CUBE;
  return [[cx, cy - h], [cx + w, cy - h / 2], [cx + w, cy + h / 2], [cx, cy + h], [cx - w, cy + h / 2], [cx - w, cy - h / 2]]
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
};

const svgSquare = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${inner}</svg>`);

const alphaOf = async (svg) => sharp(svg).ensureAlpha().extractChannel(3).raw().toBuffer();

/** One channel, 255 where the rendered picture shows the bird's yellow, grown by `blur` px. */
const birdMask = async (rgba, blur) => {
  const yellow = Buffer.alloc(SIZE * SIZE);
  for (let i = 0; i < yellow.length; i += 1) {
    const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    yellow[i] = r > 180 && g > 150 && b < 140 ? 255 : 0;
  }
  return sharp(yellow, { raw: { width: SIZE, height: SIZE, channels: 1 } }).blur(blur).threshold(20).extractChannel(0).raw().toBuffer();
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
  for (let i = 0; i < rgb.length; i += 3) rgb.set(deepenViolet([rgb[i], rgb[i + 1], rgb[i + 2]]), i);
  const cut = await sharp(rgb, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .joinChannel(keep, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .png()
    .toBuffer();
  const outline = svgSquare(`<polygon points="${hexagonPoints(OUTLINE_RADIUS)}" fill="none" stroke="#000" stroke-width="${(OUTLINE_WIDTH * UNIT).toFixed(1)}" stroke-linejoin="round"/>`);
  const full = await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: outline }, { input: cut }])
    .png()
    .toBuffer();
  return sharp(full)
    .extract({ left: CUBE.cx - CROP_HALF, top: CUBE.cy - CROP_HALF, width: CROP_HALF * 2, height: CROP_HALF * 2 })
    .resize(SIZE, SIZE)
    .png()
    .toBuffer();
};

/** The bird alone as a black template silhouette, trimmed to its bounds. */
const birdSilhouette = async (rendered) => {
  const bird = await birdMask(await sharp(rendered).ensureAlpha().raw().toBuffer(), 0.6);
  const black = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < bird.length; i += 1) black[i * 4 + 3] = bird[i];
  return sharp(black, { raw: { width: SIZE, height: SIZE, channels: 4 } }).trim().png().toBuffer();
};

/**
 * A menu bar template: the glyph at `size` with the bird, 55% of its height,
 * standing at its lower right. The picture grows to the right to make room.
 */
const menuBarTemplate = async (glyphOptions, size, silhouette) => {
  const glyph = await svgToPng(glyphSvg({ color: '#000000', zoom: MENU_BAR_GLYPH_ZOOM, ...glyphOptions }), size);
  const bird = await sharp(silhouette).resize({ height: Math.round(size * 0.55) }).png().toBuffer();
  const { width: birdWidth, height: birdHeight } = await sharp(bird).metadata();
  const width = size + Math.round(birdWidth * 0.6);
  return sharp({ create: { width, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: glyph, left: 0, top: 0 }, { input: bird, left: width - birdWidth, top: size - birdHeight }])
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
  const pixelColors = Object.fromEntries(Object.entries(CANARY_PIXEL_COLORS).map(([name, value]) => [
    name,
    Array.isArray(value[0]) ? value.map(deepenViolet) : deepenViolet(value),
  ]));
  images.set(join(iconsDir, 'icon.ico'), encodeIco(await Promise.all([16, 20, 24, 32, 40, 48, 64, 128, 256].map(async (size) => ({
    size,
    png: size <= 24 ? await pixelCubePng(size, { colors: pixelColors, bird: true }) : await resized(size),
  })))));

  const silhouette = await birdSilhouette(rendered);
  const states = [
    ['idle', {}],
    ['unseen', { walls: GLYPH_UNSEEN_WALLS }],
    ...[0, 3, 6, 9, 12, 15].map((i) => [`breath-${String(i).padStart(2, '0')}`, { rings: glyphBreathRings(i) }]),
  ];
  for (const [name, options] of states) {
    for (const size of [18, 36]) {
      images.set(join(iconsDir, 'tray', `trayTemplate-${name}${size === 36 ? '@2x' : ''}.png`), await menuBarTemplate(options, size, silhouette));
    }
  }
  // The tray menu's session status icons are not the logo; Canary uses the release ones.
  const statusDir = join(releaseIconsDir, 'tray', 'status');
  for (const name of readdirSync(statusDir)) images.set(join(iconsDir, 'tray', 'status', name), readFileSync(join(statusDir, name)));
  return images;
};
