// The OpenChamber mark as code: every drawing of the logo is built here.
//
// Units are the cube's own: half-width 41.568, half-height 48, centred on the
// origin. The roof is the rhombus around (0, -24); the tiers are smaller
// rhombi with the same centre.

const HX = 41.568;
const ROOF_HY = 24;
const ROOF_CY = -24;

const fmt = (n) => Number(n.toFixed(3)).toString();

const polygon = (points) => `M${points.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(' L')} Z`;

const rhombusPoints = (scale, { cx = 0, cy = ROOF_CY, hx = HX, hy = ROOF_HY } = {}) => [
  [cx, cy - hy * scale],
  [cx + hx * scale, cy],
  [cx, cy + hy * scale],
  [cx - hx * scale, cy],
];

/** Roof rhombus, or a tier inside it, at `scale` of the roof. */
export const rhombus = (scale, frame) => polygon(rhombusPoints(scale, frame));

/** The same rhombus wound the other way, to cut a hole with the nonzero rule. */
const rhombusReversed = (scale, frame) => {
  const [top, right, bottom, left] = rhombusPoints(scale, frame);
  return polygon([top, left, bottom, right]);
};

/** A ring between two rhombi of the same centre. */
const rhombusRing = (outer, inner, frame) => `${rhombus(outer, frame)} ${rhombusReversed(inner, frame)}`;

const SHELL_PATHS = [
  'M0 -48 L-41.568 -24 L0 0 L41.568 -24 Z',
  'M-41.568 -24 L-41.568 24 L0 48 L41.568 24 L41.568 -24',
  'M0 0 L0 48',
];
// Inner shading of the open shell: the triangles of the back walls a viewer
// sees through the missing front walls.
const LEFT_SHADE = 'M-41.568 -24 L-41.568 24 L0 0 Z';
const RIGHT_SHADE = 'M41.568 -24 L0 0 L41.568 24 Z';
const FLOOR_SHADE = 'M0 0 L-41.568 24 L0 48 L41.568 24 Z';
const OUTER_HEXAGON = 'M0 -51.12 L44.27 -25.56 L44.27 25.56 L0 51.12 L-44.27 25.56 L-44.27 -25.56 Z';

/** Tier scales, outer to core. */
export const TIER_SCALES = [0.8, 0.58, 0.36];

const shellStrokes = (color, width) => (
  `<g fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round">`
  + SHELL_PATHS.map((d) => `<path d="${d}"/>`).join('')
  + '</g>'
);

const wallGradients = (idPrefix, color, strength) => {
  const stop = (offset, opacity) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${fmt(opacity * strength)}"/>`;
  return (
    `<linearGradient id="${idPrefix}l" gradientUnits="userSpaceOnUse" x1="-42" y1="-20" x2="-2" y2="12">${stop(0, 0.08)}${stop(0.72, 0.46)}${stop(1, 0.64)}</linearGradient>`
    + `<linearGradient id="${idPrefix}r" gradientUnits="userSpaceOnUse" x1="40" y1="3" x2="3" y2="-16">${stop(0, 0.23)}${stop(0.68, 0.56)}${stop(1, 0.72)}</linearGradient>`
  );
};

// Light pooling on the floor the open front shows; the app icon only.
const floorGradient = (id, color, strength) => {
  const stop = (offset, opacity) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${fmt(opacity * strength)}"/>`;
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="-13" cy="34" r="54" gradientTransform="translate(-13 34) rotate(-24) scale(1 0.7) translate(13 -34)">${stop(0, 0.015)}${stop(0.76, 0.19)}${stop(1, 0.35)}</radialGradient>`;
};

// ---------------------------------------------------------------------------
// In-app logo: the open shell in one colour (the theme's text colour), wall
// shading, a faint roof and three tiers. Shown on every splash, About, sign-in
// and empty state.

/** Resting tier opacities, outer to core, and while each tier is lit. */
export const FLAT_TIER_OPACITY = [0.22, 0.27, 0.85];
export const FLAT_TIER_REST = [0.12, 0.15, 0.38];
export const FLAT_TIER_LIT = [0.55, 0.48, 0.85];
const FLAT_ROOF_OPACITY = 0.08;
const FLAT_STROKE = 2.2;
const FLAT_WALL_STRENGTH = 0.31;

export const FLAT_LOGO = {
  viewBox: '-50 -50 100 100',
  leftShade: LEFT_SHADE,
  rightShade: RIGHT_SHADE,
  roof: rhombus(1),
  roofOpacity: FLAT_ROOF_OPACITY,
  tiers: TIER_SCALES.map((scale) => rhombus(scale)),
  shell: SHELL_PATHS,
  stroke: FLAT_STROKE,
  wallStrength: FLAT_WALL_STRENGTH,
  wallStops: {
    left: { x1: -42, y1: -20, x2: -2, y2: 12, stops: [[0, 0.08], [0.72, 0.46], [1, 0.64]] },
    right: { x1: 40, y1: 3, x2: 3, y2: -16, stops: [[0, 0.23], [0.68, 0.56], [1, 0.72]] },
  },
};

/**
 * Inner markup of the in-app logo for a `viewBox="-50 -50 100 100"` svg.
 * `color` is any SVG paint (`currentColor`, a CSS variable). Tier paths carry
 * `data-tier` (0 outer .. 2 core) so a page script can light them in turn.
 */
export const flatLogoInner = ({ color = 'currentColor', idPrefix = 'oc-logo-' } = {}) => (
  `<defs>${wallGradients(idPrefix, color, FLAT_WALL_STRENGTH)}</defs>`
  + `<path d="${LEFT_SHADE}" fill="url(#${idPrefix}l)"/>`
  + `<path d="${RIGHT_SHADE}" fill="url(#${idPrefix}r)"/>`
  + `<path d="${rhombus(1)}" fill="${color}" fill-opacity="${FLAT_ROOF_OPACITY}"/>`
  + TIER_SCALES.map((scale, i) => `<path data-tier="${i}" d="${rhombus(scale)}" fill="${color}" fill-opacity="${FLAT_TIER_OPACITY[i]}"/>`).join('')
  + shellStrokes(color, FLAT_STROKE)
);

export const flatLogoSvg = ({ color, size = 512 }) => (
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-50 -50 100 100">`
  + flatLogoInner({ color })
  + '</svg>\n'
);

// ---------------------------------------------------------------------------
// Icon without a tile: Windows, Linux, the VS Code Marketplace, and on a black
// square for phone home screens. The open shell of the dark app icon: the
// cube's inside is dark grey, the back walls and floor show through the open
// front with the same shading, opaque grey tiers, white edges, and a thin
// black outer outline so it reads on light and dark taskbars alike.

const NO_TILE = {
  outline: '#000000',
  inside: '#2a2b2f',
  tiers: ['#787a80', '#9fa1a6', '#d4d5d8'],
  tierOpacity: 0.85,
  edge: '#f5f5f7',
};
const CUBE_SILHOUETTE = 'M0 -48 L41.568 -24 L41.568 24 L0 48 L-41.568 24 L-41.568 -24 Z';

const noTileInner = () => (
  `<defs>${wallGradients('nt-', 'white', 0.55)}${floorGradient('nt-f', 'white', 0.55)}</defs>`
  + `<path d="${OUTER_HEXAGON}" fill="none" stroke="${NO_TILE.outline}" stroke-width="3.1" stroke-linejoin="round"/>`
  + `<path d="${CUBE_SILHOUETTE}" fill="${NO_TILE.inside}"/>`
  + `<path d="${LEFT_SHADE}" fill="url(#nt-l)"/><path d="${RIGHT_SHADE}" fill="url(#nt-r)"/><path d="${FLOOR_SHADE}" fill="url(#nt-f)"/>`
  + TIER_SCALES.map((scale, i) => `<path d="${rhombus(scale)}" fill="${NO_TILE.tiers[i]}" fill-opacity="${NO_TILE.tierOpacity}"/>`).join('')
  + shellStrokes(NO_TILE.edge, 2.6)
);

// Construction tape across the lower cube, the full width of a picture `view`
// units wide: marks an unpackaged development copy.
const devTape = (view) => {
  const stripe = view * 0.0625;
  return (
    `<defs><pattern id="tape-stripes" width="${fmt(stripe)}" height="${fmt(stripe)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`
    + `<rect width="${fmt(stripe)}" height="${fmt(stripe)}" fill="#1b1b1b"/><rect width="${fmt(stripe / 2)}" height="${fmt(stripe)}" fill="#d6a23c"/></pattern></defs>`
    + `<g transform="rotate(-9)"><rect x="${fmt(-view * 0.55)}" y="${fmt(view * 0.145)}" width="${fmt(view * 1.1)}" height="${fmt(view * 0.146)}" fill="url(#tape-stripes)"/></g>`
  );
};

/** The tape alone on a transparent square, to lay over a finished icon. */
export const devTapeSvg = ({ size = 1024 } = {}) => (
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-53 -53 106 106">${devTape(106)}</svg>\n`
);

/**
 * `cubeShare` is the cube's height as a share of the square (1 = touches the
 * edges). `background` fills the square; `tape` adds the development-copy tape.
 */
export const noTileIconSvg = ({ size = 1024, background = null, cubeShare = 1, tape = false } = {}) => {
  const view = 106 / cubeShare;
  const half = view / 2;
  const back = background ? `<rect x="${fmt(-half)}" y="${fmt(-half)}" width="${fmt(view)}" height="${fmt(view)}" fill="${background}"/>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${fmt(-half)} ${fmt(-half)} ${fmt(view)} ${fmt(view)}">`
    + back + noTileInner() + (tape ? devTape(view) : '')
    + '</svg>\n'
  );
};

// ---------------------------------------------------------------------------
// Small glyph, one colour: menu bar, favicon, VS Code, model picker, Android
// notification and themed icon. Drawn on a 32 grid: the cube outline and two
// roof rings (outer faint, inner strong) around an empty centre.

const GLYPH_FRAME = { cx: 16, cy: 9.375, hx: 12.5, hy: 6.875 };
export const GLYPH_STROKE = 1.4;
const GLYPH_SHELL = [
  'M16 2.5 L28.5 9.375 L28.5 23 L16 30 L3.5 23 L3.5 9.375 Z',
  'M3.5 9.375 L16 16.25 L28.5 9.375',
  'M16 16.25 L16 30',
];
const GLYPH_WALLS = 'M3.5 9.375 L16 16.25 L16 30 L3.5 23 Z M28.5 9.375 L16 16.25 L16 30 L28.5 23 Z';
export const GLYPH_RING_OPACITY = [0.3, 0.75];

// Two rings that only touch leave an anti-aliased seam between them, which
// shows as a dark line once both are nearly opaque (the busy breath). So the
// outer opacity is one band across both rings, and the inner ring is laid
// over it with whatever opacity makes the two together reach its own.
const GLYPH_BAND = rhombusRing(0.8, 0.36, GLYPH_FRAME);
const GLYPH_INNER_RING = rhombusRing(0.58, 0.36, GLYPH_FRAME);
const overlayOpacity = (base, target) => (base >= 1 ? 0 : 1 - (1 - target) / (1 - base));

/**
 * Inner markup of the glyph on a 32 grid. `walls` fills the side walls (the
 * menu bar's "unread" state); `rings` overrides the outer and inner ring
 * opacities (the busy breath).
 */
export const glyphInner = ({ color = 'currentColor', stroke = GLYPH_STROKE, walls = 0, rings = GLYPH_RING_OPACITY } = {}) => (
  (walls ? `<path d="${GLYPH_WALLS}" fill="${color}" fill-opacity="${fmt(walls)}"/>` : '')
  + `<g fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round">`
  + GLYPH_SHELL.map((d) => `<path d="${d}"/>`).join('')
  + '</g>'
  + `<path d="${GLYPH_BAND}" fill="${color}" fill-opacity="${fmt(rings[0])}"/>`
  + `<path d="${GLYPH_INNER_RING}" fill="${color}" fill-opacity="${fmt(overlayOpacity(rings[0], rings[1]))}"/>`
);

/** `zoom` enlarges the glyph inside its square, around the cube's centre. */
export const glyphSvg = ({ size = 32, style = '', zoom = 1, ...options } = {}) => {
  const side = 32 / zoom;
  const view = zoom === 1 ? '0 0 32 32' : `${fmt(16 - side / 2)} ${fmt(16.25 - side / 2)} ${fmt(side)} ${fmt(side)}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${view}">`
    + style + glyphInner(options)
    + '</svg>\n'
  );
};

// The menu bar slot is 18 pt; the old cube filled it edge to edge, and the
// thinner glyph next to other menu bar icons looked small at the 32 grid.
export const MENU_BAR_GLYPH_ZOOM = 1.05;

/**
 * The glyph for an SF Symbol: symbols are one colour, so the two rings become
 * one solid ring, and the strokes are bolder to hold up at symbol sizes.
 */
export const glyphSymbolSvg = () => (
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
  + '<g fill="none" stroke="#000000" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">'
  + GLYPH_SHELL.map((d) => `<path d="${d}"/>`).join('')
  + '</g>'
  // The ring reaches under the roof edge, so no seam shows between them.
  + `<path d="${rhombusRing(0.9, 0.36, GLYPH_FRAME)}" fill="#000000"/>`
  + '</svg>\n'
);

/** Menu bar busy breath: frame `i` of 16, eased in and out. */
export const glyphBreathRings = (i) => {
  const e = 0.1 + 0.9 * (1 - Math.cos((Math.PI * i) / 15)) / 2;
  return [GLYPH_RING_OPACITY[0] + 0.6 * e, GLYPH_RING_OPACITY[1] + 0.25 * e];
};
export const GLYPH_UNSEEN_WALLS = 0.6;

// ---------------------------------------------------------------------------
// macOS and iOS app icon: an Icon Composer document. Layer art is white on a
// transparent 1024 canvas; colour comes from the document, so Clear and Tinted
// get real layers to work with.

const LAYER_SCALE = 6.6;
const layerSvg = (inner, defs = '') => (
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${defs}</defs>`
  + `<g transform="translate(512 512) scale(${LAYER_SCALE})">${inner}</g></svg>`
);

export const appIconLayerSvgs = () => {
  const tier = (scale, opacity) => layerSvg(`<path d="${rhombus(scale)}" fill="white" fill-opacity="${opacity}"/>`);
  const restingTiers = [0.3, 0.55, 0.95];
  return {
    'shell.png': layerSvg(
      `<path d="${LEFT_SHADE}" fill="url(#l)"/><path d="${RIGHT_SHADE}" fill="url(#r)"/><path d="${FLOOR_SHADE}" fill="url(#f)"/>${shellStrokes('white', 2.6)}`,
      wallGradients('', 'white', 0.55) + floorGradient('f', 'white', 0.55),
    ),
    'roof.png': layerSvg(`<path d="${rhombus(1)}" fill="white" fill-opacity="0"/>`),
    ...Object.fromEntries(TIER_SCALES.map((scale, i) => [`tier${i}.png`, tier(scale, restingTiers[i])])),
    ...Object.fromEntries(TIER_SCALES.map((scale, i) => [`ttier${i}.png`, tier(scale, 1)])),
  };
};

/** A solid fill, for every appearance or for the named one. */
const solid = (rgb, appearance) => {
  const value = { solid: `srgb:${rgb.map((c) => c.toFixed(5)).join(',')},1.00000` };
  return appearance ? { appearance, value } : { value };
};
const position = () => [{ idiom: 'square', value: { scale: 1.15, 'translation-in-points': [-0.65, -3.25] } }];
const layer = (name, { glass, opacity = [{ value: 1 }], fill }) => ({
  'image-name': `${name}.png`,
  name,
  'glass-specializations': glass,
  'opacity-specializations': opacity,
  'position-specializations': position(),
  'fill-specializations': fill,
});

/**
 * The Icon Composer document. Light Default: light tile, flat grey shell
 * lines and grey tiers. Dark: near-black tile, white glass shell, opaque grey
 * tiers. Clear and Tinted (the `tinted` appearance): white glass shell, opaque
 * tiers in the Canary's violets, which the system turns into separate tones.
 * Layers hidden in an appearance keep glass off there, or they still show.
 */
export const appIconDocument = () => {
  const white = [0.96, 0.96, 0.97];
  const lineGrey = [0.22, 0.22, 0.23];
  const tierGrey = [0.42, 0.42, 0.43];
  const darkTierGreys = [0.47, 0.62, 0.8];
  const tintedTiers = [[120 / 255, 98 / 255, 230 / 255], [160 / 255, 142 / 255, 245 / 255], [205 / 255, 196 / 255, 1]];
  const shellFill = [solid(lineGrey), solid(white, 'dark'), solid(white, 'tinted')];
  const shellGlass = [{ value: false }, { appearance: 'dark', value: true }, { appearance: 'tinted', value: true }];
  const lightOnly = [{ value: 1 }, { appearance: 'dark', value: 0 }, { appearance: 'tinted', value: 0 }];
  const lightHidden = [{ value: 0 }, { appearance: 'dark', value: 0.85 }, { appearance: 'tinted', value: 0.85 }];
  const restingTiers = [2, 1, 0].map((i) => layer(`tier${i}`, {
    glass: [{ value: true }],
    opacity: lightOnly,
    fill: [solid(tierGrey), solid(white, 'dark'), solid(white, 'tinted')],
  }));
  const solidTiers = [2, 1, 0].map((i) => layer(`ttier${i}`, {
    glass: shellGlass,
    opacity: lightHidden,
    fill: [solid(tintedTiers[i]), solid([darkTierGreys[i], darkTierGreys[i], darkTierGreys[i] + 0.01], 'dark')],
  }));
  return {
    'fill-specializations': [
      { value: { 'automatic-gradient': 'srgb:0.95000,0.95000,0.96000,1.00000' } },
      solid([0.075, 0.075, 0.085], 'dark'),
    ],
    groups: [
      {
        layers: [...solidTiers, ...restingTiers],
        shadow: { kind: 'layer-color', opacity: 0.5 },
        translucency: { enabled: true, value: 0.35 },
      },
      {
        layers: [
          layer('shell', { glass: shellGlass, fill: shellFill }),
          layer('roof', { glass: shellGlass, fill: shellFill }),
        ],
        shadow: { kind: 'neutral', opacity: 0.5 },
        translucency: { enabled: true, value: 0.5 },
      },
    ],
    'supported-platforms': { circles: ['watchOS'], squares: 'shared' },
  };
};
