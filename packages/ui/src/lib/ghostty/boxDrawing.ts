import type { GhosttyColor } from './core';

/**
 * Procedural glyphs for the cell-filling symbols TUI apps draw borders and
 * bars with: Box Drawing (U+2500–U+257F), Block Elements (U+2580–U+259F) and
 * the Powerline arrows (U+E0B0–U+E0B3). A font draws these only as tall as
 * its own em box, so at the terminal's 1.35 em line height every border and
 * every logo built from block characters shows a strip of background between
 * rows. Native terminals draw them to the exact cell instead; so does this.
 */
export interface BoxDrawingContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
}

export interface BoxDrawingCell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const BOX_DRAWING_FIRST = 0x2500;
const BOX_DRAWING_LAST = 0x257f;
const BLOCK_FIRST = 0x2580;
const BLOCK_LAST = 0x259f;
const POWERLINE_FIRST = 0xe0b0;
const POWERLINE_LAST = 0xe0b3;

/** Arm weights, one digit each for up, down, left, right; 0 is no arm. */
const LIGHT = 1;
const HEAVY = 2;
const DOUBLE = 3;

// Up/Down/Left/Right weights for U+2500..U+257F. Dashed, arc and diagonal
// forms carry their solid equivalent here and are special-cased when drawn.
const BOX_ARMS =
  '0011 0022 1100 2200 0011 0022 1100 2200 0011 0022 1100 2200' + // 2500-250B lines and dashes
  ' 0101 0102 0201 0202 0110 0120 0210 0220 1001 1002 2001 2002 1010 1020 2010 2020' + // 250C-251B corners
  ' 1101 1102 2101 1201 2201 2102 1202 2202' + // 251C-2523 left tees
  ' 1110 1120 2110 1210 2210 2120 1220 2220' + // 2524-252B right tees
  ' 0111 0121 0112 0122 0211 0221 0212 0222' + // 252C-2533 top tees
  ' 1011 1021 1012 1022 2011 2021 2012 2022' + // 2534-253B bottom tees
  ' 1111 1121 1112 1122 2111 1211 2211 2121 2112 1221 1212 2122 1222 2221 2212 2222' + // 253C-254B crosses
  ' 0011 0022 1100 2200' + // 254C-254F double dashes
  ' 0033 3300' + // 2550-2551 double lines
  ' 0103 0301 0303 0130 0310 0330 1003 3001 3003 1030 3010 3030' + // 2552-255D double corners
  ' 1103 3301 3303 1130 3310 3330 0133 0311 0333 1033 3011 3033 1133 3311 3333' + // 255E-256C double tees and cross
  ' 0101 0110 1010 1001' + // 256D-2570 arcs (drawn as curves)
  ' 0000 0000 0000' + // 2571-2573 diagonals (drawn as lines)
  ' 0010 1000 0001 0100 0020 2000 0002 0200' + // 2574-257B half lines
  ' 0012 1200 0021 2100'; // 257C-257F mixed half lines

const BOX_ARM_TABLE = BOX_ARMS.split(' ');

const TRIPLE_DASH = new Set([0x2504, 0x2505, 0x2506, 0x2507]);
const QUAD_DASH = new Set([0x2508, 0x2509, 0x250a, 0x250b]);
const DOUBLE_DASH = new Set([0x254c, 0x254d, 0x254e, 0x254f]);

// Block elements as unit rectangles (left, top, width, height) of the cell.
const BLOCK_RECTS = new Map<number, readonly (readonly [number, number, number, number])[]>([
  [0x2580, [[0, 0, 1, 1 / 2]]],
  [0x2581, [[0, 7 / 8, 1, 1 / 8]]],
  [0x2582, [[0, 6 / 8, 1, 2 / 8]]],
  [0x2583, [[0, 5 / 8, 1, 3 / 8]]],
  [0x2584, [[0, 1 / 2, 1, 1 / 2]]],
  [0x2585, [[0, 3 / 8, 1, 5 / 8]]],
  [0x2586, [[0, 2 / 8, 1, 6 / 8]]],
  [0x2587, [[0, 1 / 8, 1, 7 / 8]]],
  [0x2588, [[0, 0, 1, 1]]],
  [0x2589, [[0, 0, 7 / 8, 1]]],
  [0x258a, [[0, 0, 6 / 8, 1]]],
  [0x258b, [[0, 0, 5 / 8, 1]]],
  [0x258c, [[0, 0, 1 / 2, 1]]],
  [0x258d, [[0, 0, 3 / 8, 1]]],
  [0x258e, [[0, 0, 2 / 8, 1]]],
  [0x258f, [[0, 0, 1 / 8, 1]]],
  [0x2590, [[1 / 2, 0, 1 / 2, 1]]],
  [0x2594, [[0, 0, 1, 1 / 8]]],
  [0x2595, [[7 / 8, 0, 1 / 8, 1]]],
  [0x2596, [[0, 1 / 2, 1 / 2, 1 / 2]]],
  [0x2597, [[1 / 2, 1 / 2, 1 / 2, 1 / 2]]],
  [0x2598, [[0, 0, 1 / 2, 1 / 2]]],
  [0x2599, [[0, 0, 1 / 2, 1], [1 / 2, 1 / 2, 1 / 2, 1 / 2]]],
  [0x259a, [[0, 0, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]]],
  [0x259b, [[0, 0, 1, 1 / 2], [0, 1 / 2, 1 / 2, 1 / 2]]],
  [0x259c, [[0, 0, 1, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]]],
  [0x259d, [[1 / 2, 0, 1 / 2, 1 / 2]]],
  [0x259e, [[1 / 2, 0, 1 / 2, 1 / 2], [0, 1 / 2, 1 / 2, 1 / 2]]],
  [0x259f, [[1 / 2, 0, 1 / 2, 1 / 2], [0, 1 / 2, 1, 1 / 2]]],
]);

const SHADE_ALPHA = new Map([[0x2591, 0.25], [0x2592, 0.5], [0x2593, 0.75]]);

/** Whether a cell's text is a single symbol this module draws instead of the font. */
export function isBoxDrawingText(text: string): boolean {
  if (text.length === 0 || text.length > 2) return false;
  const code = text.codePointAt(0);
  if (code === undefined || String.fromCodePoint(code) !== text) return false;
  return (
    (code >= BOX_DRAWING_FIRST && code <= BOX_DRAWING_LAST) ||
    (code >= BLOCK_FIRST && code <= BLOCK_LAST) ||
    (code >= POWERLINE_FIRST && code <= POWERLINE_LAST)
  );
}

function rgba(color: GhosttyColor, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

interface CellGeometry {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly centerX: number;
  readonly centerY: number;
  /** Light stroke thickness. */
  readonly stroke: number;
  /** Half-distance between the two lines of a double stroke. */
  readonly gap: number;
}

// Everything snaps to whole CSS pixels. Neighbouring cells round the same
// shared edge to the same value, so borders meet without seams, and a whole
// pixel stays crisp at every integer device pixel ratio.
function cellGeometry(cell: BoxDrawingCell): CellGeometry {
  const left = Math.round(cell.x);
  const right = Math.round(cell.x + cell.width);
  const top = Math.round(cell.y);
  const bottom = Math.round(cell.y + cell.height);
  const stroke = Math.max(1, Math.round(cell.width / 8));
  return {
    left,
    right,
    top,
    bottom,
    centerX: Math.round(cell.x + cell.width / 2),
    centerY: Math.round(cell.y + cell.height / 2),
    stroke,
    gap: stroke + 1,
  };
}

function armThickness(weight: number, stroke: number): number {
  return weight === HEAVY ? stroke * 3 : stroke;
}

/** Fill a horizontal band [x0, x1) centered on y with the given thickness. */
function hBand(context: BoxDrawingContext, x0: number, x1: number, y: number, thickness: number): void {
  if (x1 <= x0) return;
  context.fillRect(x0, y - Math.floor(thickness / 2), x1 - x0, thickness);
}

function vBand(context: BoxDrawingContext, y0: number, y1: number, x: number, thickness: number): void {
  if (y1 <= y0) return;
  context.fillRect(x - Math.floor(thickness / 2), y0, thickness, y1 - y0);
}

function drawDashes(
  context: BoxDrawingContext,
  geometry: CellGeometry,
  horizontal: boolean,
  weight: number,
  count: number,
): void {
  const thickness = armThickness(weight, geometry.stroke);
  const start = horizontal ? geometry.left : geometry.top;
  const end = horizontal ? geometry.right : geometry.bottom;
  const gapSize = geometry.stroke;
  const span = end - start;
  const dash = Math.max(1, Math.floor((span - gapSize * (count - 1)) / count));
  for (let index = 0; index < count; index += 1) {
    const from = start + index * (dash + gapSize);
    const to = index === count - 1 ? end : from + dash;
    if (horizontal) hBand(context, from, to, geometry.centerY, thickness);
    else vBand(context, from, to, geometry.centerX, thickness);
  }
}

function drawArms(context: BoxDrawingContext, geometry: CellGeometry, arms: string): void {
  const up = Number(arms[0]);
  const down = Number(arms[1]);
  const left = Number(arms[2]);
  const right = Number(arms[3]);
  const { centerX, centerY, stroke, gap } = geometry;
  const single = (weight: number) => weight === LIGHT || weight === HEAVY;
  // A single-weight arm runs to the far edge of the thickest crossing arm's
  // band, so corners and tees fill their junction square exactly, without a
  // hole and without a stub past the perpendicular line.
  const crossV = Math.max(armThickness(up, stroke), armThickness(down, stroke), stroke);
  const crossH = Math.max(armThickness(left, stroke), armThickness(right, stroke), stroke);
  const bandLeft = centerX - Math.floor(crossV / 2);
  const bandRight = bandLeft + crossV;
  const bandTop = centerY - Math.floor(crossH / 2);
  const bandBottom = bandTop + crossH;
  const verticalDouble = up === DOUBLE || down === DOUBLE;
  const horizontalDouble = left === DOUBLE || right === DOUBLE;

  if (single(left)) {
    hBand(context, geometry.left, verticalDouble ? centerX - gap : bandRight, centerY, armThickness(left, stroke));
  }
  if (single(right)) {
    hBand(context, verticalDouble ? centerX + gap : bandLeft, geometry.right, centerY, armThickness(right, stroke));
  }
  if (single(up)) {
    vBand(context, geometry.top, horizontalDouble ? centerY - gap : bandBottom, centerX, armThickness(up, stroke));
  }
  if (single(down)) {
    vBand(context, horizontalDouble ? centerY + gap : bandTop, geometry.bottom, centerX, armThickness(down, stroke));
  }

  // A double arm is two light lines. Where a line meets the perpendicular arm
  // on its own side it stops at that arm's matching line (a double arm), at
  // the center (a single arm), or crosses to the far line to close a corner
  // or run straight through (no arm). `sign` is +1 toward the far side.
  const stopX = (perpendicular: number, sign: 1 | -1) =>
    perpendicular === DOUBLE ? centerX - sign * gap : single(perpendicular) ? centerX : centerX + sign * gap;
  const stopY = (perpendicular: number, sign: 1 | -1) =>
    perpendicular === DOUBLE ? centerY - sign * gap : single(perpendicular) ? centerY : centerY + sign * gap;
  if (left === DOUBLE) {
    hBand(context, geometry.left, stopX(up, 1), centerY - gap, stroke);
    hBand(context, geometry.left, stopX(down, 1), centerY + gap, stroke);
  }
  if (right === DOUBLE) {
    hBand(context, stopX(up, -1), geometry.right, centerY - gap, stroke);
    hBand(context, stopX(down, -1), geometry.right, centerY + gap, stroke);
  }
  if (up === DOUBLE) {
    vBand(context, geometry.top, stopY(left, 1), centerX - gap, stroke);
    vBand(context, geometry.top, stopY(right, 1), centerX + gap, stroke);
  }
  if (down === DOUBLE) {
    vBand(context, stopY(left, -1), geometry.bottom, centerX - gap, stroke);
    vBand(context, stopY(right, -1), geometry.bottom, centerX + gap, stroke);
  }
}

function drawArc(context: BoxDrawingContext, geometry: CellGeometry, code: number): void {
  const { centerX, centerY, stroke } = geometry;
  // 256D ╭ down+right, 256E ╮ down+left, 256F ╯ up+left, 2570 ╰ up+right
  const toRight = code === 0x256d || code === 0x2570;
  const toDown = code === 0x256d || code === 0x256e;
  const endX = toRight ? geometry.right : geometry.left;
  const endY = toDown ? geometry.bottom : geometry.top;
  const radius = Math.min(Math.abs(endX - centerX), Math.abs(endY - centerY));
  const dirX = toRight ? 1 : -1;
  const dirY = toDown ? 1 : -1;
  // An odd stroke sits on pixel centers, matching the fillRect bands of the
  // straight forms so a curve continues a line without a half-pixel step.
  const align = (stroke % 2) / 2;
  const cx = centerX + align;
  const cy = centerY + align;
  context.beginPath();
  context.moveTo(endX, cy);
  context.lineTo(cx + dirX * radius, cy);
  context.quadraticCurveTo(cx, cy, cx, cy + dirY * radius);
  context.lineTo(cx, endY);
  context.lineWidth = stroke;
  context.lineCap = 'butt';
  context.stroke();
}

function drawDiagonal(context: BoxDrawingContext, geometry: CellGeometry, code: number): void {
  context.lineWidth = geometry.stroke;
  context.lineCap = 'butt';
  context.beginPath();
  if (code === 0x2571 || code === 0x2573) {
    context.moveTo(geometry.right, geometry.top);
    context.lineTo(geometry.left, geometry.bottom);
  }
  if (code === 0x2572 || code === 0x2573) {
    context.moveTo(geometry.left, geometry.top);
    context.lineTo(geometry.right, geometry.bottom);
  }
  context.stroke();
}

function drawPowerline(context: BoxDrawingContext, geometry: CellGeometry, code: number): void {
  const { left, right, top, bottom, centerY } = geometry;
  const pointsRight = code === 0xe0b0 || code === 0xe0b1;
  const tip = pointsRight ? right : left;
  const base = pointsRight ? left : right;
  context.beginPath();
  context.moveTo(base, top);
  context.lineTo(tip, centerY);
  context.lineTo(base, bottom);
  if (code === 0xe0b0 || code === 0xe0b2) {
    context.closePath();
    context.fill();
    return;
  }
  context.lineWidth = geometry.stroke;
  context.lineCap = 'butt';
  context.stroke();
}

/**
 * Draw one symbol into its cell. Returns false when the code point is not a
 * symbol this module owns, so the caller falls back to the font.
 */
export function drawBoxDrawingGlyph(
  context: BoxDrawingContext,
  text: string,
  cell: BoxDrawingCell,
  color: GhosttyColor,
): boolean {
  if (!isBoxDrawingText(text)) return false;
  const code = text.codePointAt(0) ?? 0;
  const geometry = cellGeometry(cell);
  const solid = rgba(color, 1);
  context.fillStyle = solid;
  context.strokeStyle = solid;

  if (code >= BLOCK_FIRST && code <= BLOCK_LAST) {
    const shade = SHADE_ALPHA.get(code);
    if (shade !== undefined) {
      context.fillStyle = rgba(color, shade);
      context.fillRect(geometry.left, geometry.top, geometry.right - geometry.left, geometry.bottom - geometry.top);
      return true;
    }
    const width = geometry.right - geometry.left;
    const height = geometry.bottom - geometry.top;
    for (const [x, y, w, h] of BLOCK_RECTS.get(code) ?? []) {
      // Edges of eighths snap independently so stacked bars still tile.
      const x0 = geometry.left + Math.round(x * width);
      const x1 = geometry.left + Math.round((x + w) * width);
      const y0 = geometry.top + Math.round(y * height);
      const y1 = geometry.top + Math.round((y + h) * height);
      context.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    }
    return true;
  }

  if (code >= POWERLINE_FIRST && code <= POWERLINE_LAST) {
    drawPowerline(context, geometry, code);
    return true;
  }

  if (code >= 0x256d && code <= 0x2570) {
    drawArc(context, geometry, code);
    return true;
  }
  if (code >= 0x2571 && code <= 0x2573) {
    drawDiagonal(context, geometry, code);
    return true;
  }
  const arms = BOX_ARM_TABLE[code - BOX_DRAWING_FIRST] ?? '0000';
  const dashCount = TRIPLE_DASH.has(code) ? 3 : QUAD_DASH.has(code) ? 4 : DOUBLE_DASH.has(code) ? 2 : 0;
  if (dashCount > 0) {
    const horizontal = arms[2] !== '0';
    drawDashes(context, geometry, horizontal, Number(horizontal ? arms[2] : arms[0]), dashCount);
    return true;
  }
  drawArms(context, geometry, arms);
  return true;
}
