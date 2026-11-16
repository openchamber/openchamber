import { collectWrappedTerminalLinkLine, extractTerminalLinks } from './terminalLinks';
import { canvasFontFamilies, isMonospaceFamily } from './fonts';
import {
  GhosttyTerminalCore,
  type GhosttyScrollbar,
  type GhosttySnapshot,
  type GhosttyTheme,
} from './core';
import {
  measureGhosttyCell,
  renderGhosttySnapshot,
  terminalGridSize,
  type GhosttyCellRange,
  type GhosttyCellMetrics,
} from './renderer';

const symbolsFontUrl = new URL('./fonts/SymbolsNerdFontMono-Regular.woff2', import.meta.url).href;

const DEFAULT_TERMINAL_FONT_SIZE = 13;
const MIN_TERMINAL_FONT_SIZE = 6;
const MAX_TERMINAL_FONT_SIZE = 32;
const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;
const TOUCH_MOUSE_COMPAT_WINDOW_MS = 1000;

const isMacPlatform = (platform: string): boolean => /mac|iphone|ipad|ipod/i.test(platform);
const TERMINAL_GLYPH_FALLBACKS =
  '"Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", ' +
  '"JetBrainsMono NF", "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS NF", ' +
  '"CaskaydiaCove Nerd Font", "PowerlineSymbols", monospace';
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", ' + TERMINAL_GLYPH_FALLBACKS;
const CONTENT_PADDING = 4;
const MIN_SCROLLBAR_THUMB_HEIGHT = 18;
const CURSOR_BLINK_INTERVAL_MS = 500;
const TERMINAL_FONT_LOAD_TEXT = 'iMW0@# .';
const TERMINAL_FONT_LOAD_VARIANTS = [
  'normal 400',
  'normal 700',
  'italic 400',
  'italic 700',
] as const;

export interface GhosttyTerminalFont {
  readonly family?: string;
  readonly size?: number;
}

let symbolsFontLoad: Promise<void> | null = null;

function ensureTerminalSymbolsFont(): Promise<void> {
  if (symbolsFontLoad !== null) return symbolsFontLoad;
  symbolsFontLoad = (async () => {
    try {
      const face = new FontFace('Symbols Nerd Font Mono', `url(${symbolsFontUrl})`);
      document.fonts.add(await face.load());
    } catch {
      // Locally installed fallback faces still apply.
    }
  })();
  return symbolsFontLoad;
}

function uncheckedTerminalFontFamily(family?: string): string {
  const custom = family === undefined ? null : canvasFontFamilies(family);
  return custom === null ? DEFAULT_TERMINAL_FONT_FAMILY : `${custom}, ${DEFAULT_TERMINAL_FONT_FAMILY}`;
}

function terminalFontFamily(family?: string): string {
  const custom = family === undefined ? null : canvasFontFamilies(family);
  if (custom === null) return DEFAULT_TERMINAL_FONT_FAMILY;
  if (!isMonospaceFamily(custom)) return DEFAULT_TERMINAL_FONT_FAMILY;
  return uncheckedTerminalFontFamily(custom);
}

export async function loadTerminalFontFamily(
  family: string | undefined,
  size: number,
  environment?: {
    readonly load: (font: string, text: string) => Promise<void>;
    readonly resolve: (family: string | undefined) => string;
  },
): Promise<string> {
  const candidate = uncheckedTerminalFontFamily(family);
  const load =
    environment?.load ??
    ((font: string, text: string) => document.fonts.load(font, text).then(() => undefined));
  try {
    await Promise.all(
      TERMINAL_FONT_LOAD_VARIANTS.map((variant) =>
        load(`${variant} ${size}px ${candidate}`, TERMINAL_FONT_LOAD_TEXT),
      ),
    );
  } catch {
    // The fixed-width fallback stack remains available if a face cannot load.
  }
  return (environment?.resolve ?? terminalFontFamily)(family);
}

export function terminalFontSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)));
}

export function shouldBlinkTerminalCursor(state: {
  readonly focused: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.focused && state.cursorBlinking && state.cursorVisible && !state.reducedMotion;
}

export function terminalContentOriginY(
  mountHeight: number,
  padding: number,
  rows: number,
  cellHeight: number,
  anchorBottom: boolean,
): number {
  if (!anchorBottom) return padding;
  const slack = mountHeight - padding * 2 - rows * cellHeight;
  return padding + Math.max(0, slack);
}

export interface TerminalScrollbarGeometry {
  readonly thumbHeight: number;
  readonly thumbTop: number;
  readonly maxOffset: number;
}

export function terminalScrollbarGeometry(
  state: GhosttyScrollbar,
  trackHeight: number,
): TerminalScrollbarGeometry | null {
  const total = Math.max(0, state.total);
  const len = Math.max(0, Math.min(state.len, total));
  const maxOffset = Math.max(0, total - len);
  if (trackHeight <= 0 || len <= 0 || maxOffset === 0) return null;
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(MIN_SCROLLBAR_THUMB_HEIGHT, (trackHeight * len) / total),
  );
  const travel = Math.max(0, trackHeight - thumbHeight);
  const offset = Math.max(0, Math.min(state.offset, maxOffset));
  return {
    thumbHeight,
    thumbTop: travel * (offset / maxOffset),
    maxOffset,
  };
}

export function terminalScrollbarOffsetAtPointer(
  state: GhosttyScrollbar,
  trackHeight: number,
  pointerY: number,
  pointerOffset: number,
): number {
  const geometry = terminalScrollbarGeometry(state, trackHeight);
  if (geometry === null) return 0;
  const travel = Math.max(0, trackHeight - geometry.thumbHeight);
  if (travel === 0) return 0;
  const thumbTop = Math.max(0, Math.min(pointerY - pointerOffset, travel));
  return Math.round((thumbTop / travel) * geometry.maxOffset);
}

export function terminalGridCellAt(options: {
  bounds: { left: number; top: number };
  clientX: number;
  clientY: number;
  cols: number;
  rows: number;
  metrics: Pick<GhosttyCellMetrics, 'width' | 'height'>;
  padding: number;
  originY: number;
}): { x: number; y: number } | null {
  const { bounds, clientX, clientY, cols, rows, metrics, padding, originY } = options;
  const gridX = clientX - bounds.left - padding;
  const gridY = clientY - bounds.top - originY;
  if (gridX < 0 || gridY < 0 || gridX >= cols * metrics.width || gridY >= rows * metrics.height) {
    return null;
  }
  return {
    x: Math.floor(gridX / metrics.width),
    y: Math.floor(gridY / metrics.height),
  };
}

function terminalRowText(row: GhosttySnapshot['rowData'][number], trimRight: boolean): string {
  const text = row.cells.map((cell) => cell.text || ' ').join('');
  return trimRight ? text.trimEnd() : text;
}

function terminalColumnOffset(row: GhosttySnapshot['rowData'][number], column: number): number {
  let offset = 0;
  for (let cellIndex = 0; cellIndex < column; cellIndex += 1) {
    offset += row.cells[cellIndex]?.text.length || 1;
  }
  return offset;
}

export interface TerminalLinkWithRange {
  readonly text: string;
  readonly range: GhosttyCellRange;
}

function terminalColumnAtOffset(row: GhosttySnapshot['rowData'][number], offset: number): number {
  for (let column = 0; column < row.cells.length; column += 1) {
    const nextOffset = terminalColumnOffset(row, column + 1);
    if (offset < nextOffset) return column;
  }
  return Math.max(0, row.cells.length - 1);
}

export function terminalLinkAtPositionWithRange(
  rows: GhosttySnapshot['rowData'],
  rowIndex: number,
  column: number,
): TerminalLinkWithRange | null {
  const wrappedLine = collectWrappedTerminalLinkLine(rowIndex + 1, (index) => {
    const row = rows[index];
    if (!row) return null;
    return {
      isWrapped: row.isWrapContinuation,
      translateToString: (trimRight = false) => terminalRowText(row, trimRight),
    };
  });
  if (!wrappedLine) return null;
  const firstSegment = wrappedLine.segments[0];
  if (firstSegment && rows[firstSegment.bufferLineNumber - 1]?.isWrapContinuation) {
    return null;
  }
  const segment = wrappedLine.segments.find((value) => value.bufferLineNumber === rowIndex + 1);
  const row = rows[rowIndex];
  if (!segment || !row) return null;
  const lastSegment = wrappedLine.segments.at(-1);
  const lastRow = lastSegment ? rows[lastSegment.bufferLineNumber - 1] : undefined;
  const continuesBelowViewport = lastRow !== undefined && lastRow.wrapsToNext;
  const offset = segment.startIndex + terminalColumnOffset(row, column);
  for (const match of extractTerminalLinks(wrappedLine.text)) {
    if (offset >= match.start && offset < match.end) {
      if (match.end === wrappedLine.text.length && continuesBelowViewport) return null;
      const startSegment = wrappedLine.segments.find(
        (value) => match.start >= value.startIndex && match.start < value.endIndex,
      );
      const endSegment = wrappedLine.segments.find(
        (value) => match.end - 1 >= value.startIndex && match.end - 1 < value.endIndex,
      );
      const startRow = startSegment ? rows[startSegment.bufferLineNumber - 1] : undefined;
      const endRow = endSegment ? rows[endSegment.bufferLineNumber - 1] : undefined;
      if (!startSegment || !endSegment || !startRow || !endRow) return null;
      return {
        text: match.text,
        range: {
          start: {
            x: terminalColumnAtOffset(startRow, match.start - startSegment.startIndex),
            y: startSegment.bufferLineNumber - 1,
          },
          end: {
            x: terminalColumnAtOffset(endRow, match.end - 1 - endSegment.startIndex),
            y: endSegment.bufferLineNumber - 1,
          },
        },
      };
    }
  }
  return null;
}

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  platform = navigator.platform,
) {
  if (event.key.toLowerCase() !== 'c') return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

function primeTerminalCopyInput(
  input: Pick<HTMLTextAreaElement, 'value' | 'select'>,
  selection: string,
): void {
  input.value = selection;
  input.select();
}

function clearPrimedTerminalCopyInput(
  input: Pick<HTMLTextAreaElement, 'value'>,
  primedSelection: string,
  restingValue: string,
): void {
  if (primedSelection.length === 0 || input.value !== primedSelection) return;
  input.value = restingValue;
}

function terminalRestingInputValue(userAgent: string): string {
  return /Android/i.test(userAgent) ? ' ' : '';
}

interface TerminalCopyEventResult {
  readonly preventDefault: boolean;
  readonly claimWriteFallback: boolean;
}

function applyTerminalCopyEvent(
  selection: string,
  clipboardData: { setData: (type: string, data: string) => void } | null | undefined,
): TerminalCopyEventResult {
  if (selection.length === 0 || !clipboardData) {
    return { preventDefault: false, claimWriteFallback: false };
  }
  clipboardData.setData('text/plain', selection);
  return { preventDefault: true, claimWriteFallback: true };
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  platform = navigator.platform,
) {
  const key = event.key.toLowerCase();
  if (key === 'insert' && !isMacPlatform(platform)) {
    return event.shiftKey && !event.ctrlKey && !event.metaKey;
  }
  if (key !== 'v') return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

export function isTerminalMacAppShortcut(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>,
  platform = navigator.platform,
) {
  return isMacPlatform(platform) && event.metaKey && !event.ctrlKey;
}

export function isTerminalZoomShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  platform = navigator.platform,
) {
  if (isMacPlatform(platform) || event.altKey || event.shiftKey) return false;
  if (event.code !== 'Equal' && event.code !== 'Minus' && event.code !== 'Digit0') return false;
  return event.ctrlKey && !event.metaKey;
}

type MacTextEditingEvent = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'>;

export function encodeMacLineShortcut(event: MacTextEditingEvent, platform = navigator.platform): string | null {
  if (!isMacPlatform(platform) || !event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || event.isComposing) return null;
  switch (event.key) {
    case 'Backspace': return '\x15';
    case 'ArrowLeft': return '\x01';
    case 'ArrowRight': return '\x05';
    default: return null;
  }
}

export type TerminalViewportScroll = 'top' | 'bottom' | 'page-up' | 'page-down';

const viewportScrollFor = (key: string): TerminalViewportScroll | null => {
  switch (key) {
    case 'Home': return 'top';
    case 'End': return 'bottom';
    case 'PageUp': return 'page-up';
    case 'PageDown': return 'page-down';
    default: return null;
  }
};

export function terminalViewportScrollShortcut(
  event: MacTextEditingEvent,
  platform = navigator.platform,
): TerminalViewportScroll | null {
  const scroll = viewportScrollFor(event.key);
  if (scroll === null || event.ctrlKey || event.altKey || event.isComposing) return null;
  const owned = isMacPlatform(platform)
    ? event.metaKey && !event.shiftKey
    : event.shiftKey && !event.metaKey;
  return owned ? scroll : null;
}

const SHORTCUT_PASTE_ECHO_MS = 1000;

export class TerminalPasteArbiter {
  private token = 0;
  private owedNativePastes = 0;
  private lastShortcutReadAt = 0;

  beginRead(): number {
    return ++this.token;
  }

  settleRead(token: number, owesNativePaste: boolean, now: number): boolean {
    if (this.token !== token) return false;
    this.token += 1;
    if (owesNativePaste) {
      this.expireOwedPastes(now);
      this.owedNativePastes += 1;
      this.lastShortcutReadAt = now;
    }
    return true;
  }

  settleNativePaste(now: number): boolean {
    this.token += 1;
    this.expireOwedPastes(now);
    if (this.owedNativePastes === 0) return true;
    this.owedNativePastes -= 1;
    return false;
  }

  private expireOwedPastes(now: number): void {
    if (now - this.lastShortcutReadAt > SHORTCUT_PASTE_ECHO_MS) this.owedNativePastes = 0;
  }
}

function isTerminalCompositionCommitInput(event: Pick<InputEvent, 'inputType'>): boolean {
  return (
    event.inputType === '' ||
    event.inputType === 'insertCompositionText' ||
    event.inputType === 'insertFromComposition'
  );
}

function isTerminalCompositionKey(
  event: Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode'>,
  composing: boolean,
): boolean {
  return event.isComposing || composing || event.key === 'Process' || event.keyCode === 229;
}

function isTerminalAltGraphText(
  event: Pick<KeyboardEvent, 'getModifierState' | 'key'>,
): boolean {
  return event.getModifierState('AltGraph') && [...event.key].length === 1;
}

function shouldReportTerminalMouse(
  tracking: boolean,
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): boolean {
  return tracking && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

const MIDDLE_CLICK_PASTE_WINDOW_MS = 1000;

type TerminalMouseAction = 'press' | 'release' | 'motion';

export interface TerminalMouseDataResolution {
  readonly send: boolean;
  readonly nextMotionData: string;
}

interface TerminalMouseTrackingState {
  readonly tracking: boolean;
  readonly motionData: string;
}

export interface TerminalWheelRows {
  readonly rows: number;
  readonly remainder: number;
}

export function resolveTerminalMouseData(
  action: TerminalMouseAction,
  data: string,
  previousMotionData: string,
): TerminalMouseDataResolution {
  const nextMotionData = action === 'motion' ? data : '';
  return {
    send: data.length > 0 && (action !== 'motion' || data !== previousMotionData),
    nextMotionData,
  };
}

function resolveTerminalMouseTrackingState(
  previousTracking: boolean,
  tracking: boolean,
  motionData: string,
): TerminalMouseTrackingState {
  return {
    tracking,
    motionData: previousTracking === tracking ? motionData : '',
  };
}

export function terminalWheelDeltaRows(
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  viewportRows: number,
  remainder: number,
): TerminalWheelRows {
  // external: https://developer.mozilla.org/en-US/docs/Web/API/WheelEvent/deltaMode 0 is pixels, 1 lines, 2 pages.
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * cellHeight
      : event.deltaMode === 2
        ? event.deltaY * viewportRows * cellHeight
        : event.deltaY;
  const total = remainder + pixels / cellHeight;
  const rows = Math.trunc(total);
  return { rows, remainder: total - rows };
}

export function terminalWheelArrowData(rows: number, applicationCursorKeys: boolean): string {
  if (rows === 0) return '';
  const sequence =
    rows < 0
      ? applicationCursorKeys
        ? '\u001bOA'
        : '\u001b[A'
      : applicationCursorKeys
        ? '\u001bOB'
        : '\u001b[B';
  return sequence.repeat(Math.abs(rows));
}

export function isTerminalLinkPointerGesture(
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  platform = navigator.platform,
): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

function ghosttyMouseButton(button: number): number | null {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      return null;
  }
}

export interface TerminalSelectionClickSequence {
  readonly count: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export function advanceTerminalSelectionClickSequence(
  previous: TerminalSelectionClickSequence | null,
  event: Pick<PointerEvent, 'clientX' | 'clientY' | 'timeStamp'>,
): TerminalSelectionClickSequence {
  const repeats =
    previous !== null &&
    event.timeStamp - previous.time <= SELECTION_MULTI_CLICK_INTERVAL_MS &&
    Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 4;
  return {
    count: repeats ? (previous.count >= 3 ? 1 : previous.count + 1) : 1,
    time: event.timeStamp,
    x: event.clientX,
    y: event.clientY,
  };
}

export interface GhosttyGridPoint {
  readonly x: number;
  readonly y: number;
}

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly font?: GhosttyTerminalFont;
  readonly visible?: boolean;
  readonly labels: { readonly input: string; readonly scrollbar: string };
  readonly handleTouchPointer?: boolean;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange?: () => void;
  readonly onMiddleClickPaste?: () => void;
  readonly beforeKey?: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate?: (text: string, event: MouseEvent) => void;
  readonly onContextMenu?: (event: MouseEvent) => void;
}

export class GhosttyTerminalSurface {
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly preedit: HTMLDivElement;
  readonly scrollbar: HTMLDivElement;
  cols = 1;
  rows = 1;

  private readonly mount: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly core: GhosttyTerminalCore;
  private readonly options: GhosttyTerminalSurfaceOptions;
  private visible: boolean;
  private hasSize = false;
  private metrics: GhosttyCellMetrics;
  private fontFamily: string;
  private requestedFontFamily: string | undefined;
  private fontSize: number;
  private fontEpoch = 0;
  private pendingFontEpoch: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly scrollbarThumb: HTMLDivElement;
  private snapshot: GhosttySnapshot | null = null;
  private frame = 0;
  private cursorTimer: number | null = null;
  private compositionInputToSuppress: string | null = null;
  private compositionSuppressionTimer: number | null = null;
  private cursorOn = true;
  private renderedCursorY: number | null = null;
  private forceFullRender = true;
  private scrollbarDirty = true;
  private scrollbarState: GhosttyScrollbar | null = null;
  private scrollbarPointerId: number | null = null;
  private scrollbarPointerOffset = 0;
  private disposed = false;
  private resizeNotifyTimer: number | null = null;
  private originY = CONTENT_PADDING;
  private mountHeight = 0;
  private selectionEnd: { x: number; y: number } | null = null;
  private selectionAnchorScreen: { x: number; y: number } | null = null;
  private selectionEndScreen: { x: number; y: number } | null = null;
  private selectionMode: 'cell' | 'word' | 'line' = 'cell';
  private selectionBase: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null = null;
  private selectionScrollTimer: number | null = null;
  private selectionScrollDelta = 0;
  private selectionPointer: { x: number; y: number } | null = null;
  private mouseReportingPointerId: number | null = null;
  private mouseReportingButton: number | null = null;
  private linkActivationPointerId: number | null = null;
  private hoveredLink: TerminalLinkWithRange | null = null;
  private hoverPointer: { x: number; y: number } | null = null;
  private linkModifierActive = false;
  private selectionClickSequence: TerminalSelectionClickSequence | null = null;
  private selectionMoved = false;
  private composing = false;
  private focused = false;
  private resizeNotified = false;
  private canvasConfigured = false;
  private theme: GhosttyTheme;
  private readonly suppressedKeyCodes = new Set<string>();
  private readonly pasteArbiter = new TerminalPasteArbiter();
  private middleClickPasteAt: number | null = null;
  private copyShortcutToken = 0;
  private clearSelectionAfterCopy = false;
  private primedCopySelection = '';
  private readonly restingInputValue = terminalRestingInputValue(navigator.userAgent);
  private wheelRemainder = 0;
  private lastMouseMotionData = '';
  private mouseAnyEventTracking = false;
  private dprMedia: MediaQueryList | null = null;
  private readonly reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  private inputLeft = -1;
  private inputTop = -1;
  private lastTouchPointerAt = Number.NEGATIVE_INFINITY;

  private constructor(
    mount: HTMLElement,
    canvas: HTMLCanvasElement,
    input: HTMLTextAreaElement,
    preedit: HTMLDivElement,
    scrollbar: HTMLDivElement,
    scrollbarThumb: HTMLDivElement,
    context: CanvasRenderingContext2D,
    core: GhosttyTerminalCore,
    metrics: GhosttyCellMetrics,
    fontFamily: string,
    options: GhosttyTerminalSurfaceOptions,
  ) {
    this.mount = mount;
    this.canvas = canvas;
    this.input = input;
    this.preedit = preedit;
    this.scrollbar = scrollbar;
    this.scrollbarThumb = scrollbarThumb;
    this.context = context;
    this.core = core;
    this.mouseAnyEventTracking = core.isMouseAnyEventTracking();
    this.metrics = metrics;
    this.options = options;
    this.visible = options.visible ?? true;
    this.theme = options.theme;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = options.font?.family;
    this.fontSize = terminalFontSize(options.font?.size);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.stylePreedit();
    this.resetInput();
    this.installEvents();
    this.watchDevicePixelRatio();
    this.reducedMotionMedia?.addEventListener('change', this.onReducedMotionChange);
    document.fonts.addEventListener('loadingdone', this.onFontsLoaded);
    this.resizeObserver.observe(mount);
  }

  static async create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions,
  ): Promise<GhosttyTerminalSurface> {
    const canvas = document.createElement('canvas');
    canvas.className = 'oc-terminal-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    const input = document.createElement('textarea');
    input.className = 'oc-terminal-input';
    input.setAttribute('aria-label', options.labels.input);
    input.setAttribute('autocorrect', 'off');
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const preedit = document.createElement('div');
    preedit.className = 'oc-terminal-preedit';
    preedit.setAttribute('aria-hidden', 'true');
    preedit.hidden = true;

    const scrollbar = document.createElement('div');
    scrollbar.className = 'oc-terminal-scrollbar';
    scrollbar.setAttribute('role', 'scrollbar');
    scrollbar.setAttribute('aria-label', options.labels.scrollbar);
    scrollbar.setAttribute('aria-orientation', 'vertical');
    scrollbar.tabIndex = -1;
    scrollbar.hidden = true;
    const scrollbarThumb = document.createElement('div');
    scrollbarThumb.className = 'oc-terminal-scrollbar-thumb';
    scrollbar.append(scrollbarThumb);
    mount.replaceChildren(canvas, input, preedit, scrollbar);
    const initialRatio = window.devicePixelRatio || 1;
    if (mount.clientWidth > 0 && mount.clientHeight > 0) {
      canvas.width = Math.max(1, Math.round(mount.clientWidth * initialRatio));
      canvas.height = Math.max(1, Math.round(mount.clientHeight * initialRatio));
    }

    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D is unavailable');
    context.fillStyle = `rgb(${options.theme.background.r}, ${options.theme.background.g}, ${options.theme.background.b})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const fontSize = terminalFontSize(options.font?.size);
    try {
      await ensureTerminalSymbolsFont();
    } catch {
      // Metrics fall back to whichever faces are already available.
    }
    const fontFamily = await loadTerminalFontFamily(options.font?.family, fontSize);
    const metrics = measureGhosttyCell(context, fontSize, fontFamily);
    const grid = terminalGridSize(mount.clientWidth, mount.clientHeight, metrics, CONTENT_PADDING);
    const core = await GhosttyTerminalCore.create(
      grid.cols,
      grid.rows,
      metrics.width,
      metrics.height,
      options.theme,
      options.onData,
    );
    const surface = new GhosttyTerminalSurface(
      mount,
      canvas,
      input,
      preedit,
      scrollbar,
      scrollbarThumb,
      context,
      core,
      metrics,
      fontFamily,
      options,
    );
    surface.fit();
    return surface;
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.cursorOn = true;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    if (!visible) {
      this.cancelRender();
      this.setSelectionAutoscroll(0);
      return;
    }
    this.fit();
  }

  write(data: string): void {
    if (this.disposed) return;
    this.core.write(data);
    this.synchronizeMouseTrackingState();
    this.cursorOn = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  resetAndWrite(data: string, drawnSize?: { readonly cols: number; readonly rows: number }): void {
    if (this.disposed) return;
    this.lastMouseMotionData = '';
    const replayAtDrawnSize =
      drawnSize !== undefined && (drawnSize.cols !== this.cols || drawnSize.rows !== this.rows);
    if (replayAtDrawnSize) {
      this.core.resize(drawnSize.cols, drawnSize.rows, this.metrics.width, this.metrics.height);
    }
    try {
      this.core.resetAndWrite(data);
    } finally {
      if (replayAtDrawnSize) {
        this.core.resize(this.cols, this.rows, this.metrics.width, this.metrics.height);
      }
    }
    this.synchronizeMouseTrackingState();
    this.cursorOn = true;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  setTheme(theme: GhosttyTheme): void {
    if (this.disposed) return;
    this.theme = theme;
    this.core.setTheme(theme);
    this.stylePreedit();
    this.forceFullRender = true;
    this.requestRender();
  }

  async setFont(font: GhosttyTerminalFont): Promise<void> {
    if (this.disposed) return;
    const fontSize = terminalFontSize(font.size);
    const epoch = ++this.fontEpoch;
    this.pendingFontEpoch = epoch;
    const fontFamily = await loadTerminalFontFamily(font.family, fontSize);
    if (this.disposed || epoch !== this.fontEpoch) return;
    this.pendingFontEpoch = null;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = font.family;
    this.fontSize = fontSize;
    this.applyFontMetrics();
  }

  private applyFontMetrics(): void {
    this.metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);
    this.core.resize(this.cols, this.rows, this.metrics.width, this.metrics.height);
    this.stylePreedit();
    this.inputLeft = -1;
    this.inputTop = -1;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.fit();
    this.requestRender();
  }

  private readonly onReducedMotionChange = () => {
    if (this.disposed) return;
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onFontsLoaded = () => {
    if (this.disposed) return;
    if (this.pendingFontEpoch !== null) return;
    const fontFamily = terminalFontFamily(this.requestedFontFamily);
    if (fontFamily !== this.fontFamily) {
      this.fontFamily = fontFamily;
      this.applyFontMetrics();
      return;
    }
    const metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);
    if (
      metrics.width === this.metrics.width &&
      metrics.height === this.metrics.height &&
      metrics.baseline === this.metrics.baseline
    ) {
      return;
    }
    this.applyFontMetrics();
  };

  fit(): boolean {
    if (this.disposed || !this.visible) return false;
    const width = this.mount.clientWidth;
    const height = this.mount.clientHeight;
    if (width <= 0 || height <= 0) {
      this.hasSize = false;
      this.forceFullRender = true;
      this.cancelRender();
      return false;
    }
    this.hasSize = true;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    let shouldRender = false;
    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight ||
      !this.canvasConfigured
    ) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.canvasConfigured = true;
      this.forceFullRender = true;
      this.scrollbarDirty = true;
      shouldRender = true;
    }
    const grid = terminalGridSize(width, height, this.metrics, CONTENT_PADDING);
    this.mountHeight = height;
    if (grid.cols !== this.cols || grid.rows !== this.rows || !this.resizeNotified) {
      this.cols = grid.cols;
      this.rows = grid.rows;
      this.core.resize(grid.cols, grid.rows, this.metrics.width, this.metrics.height);
      this.notifyResize();
      this.forceFullRender = true;
      this.scrollbarDirty = true;
      shouldRender = true;
    }
    if (shouldRender || this.forceFullRender) this.renderFrame();
    return true;
  }

  private notifyResize(): void {
    this.resizeNotified = true;
    if (this.resizeNotifyTimer !== null) window.clearTimeout(this.resizeNotifyTimer);
    this.resizeNotifyTimer = window.setTimeout(() => {
      this.resizeNotifyTimer = null;
      if (!this.disposed) this.options.onResize(this.cols, this.rows);
    }, 150);
  }

  focus(): void {
    if (this.disposed || !this.visible) return;
    this.input.focus({ preventScroll: true });
  }

  async pasteFromClipboard(
    readText: () => Promise<string>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const token = this.pasteArbiter.beginRead();
    const text = await readText();
    if (this.disposed || !isCurrent()) return;
    if (!this.pasteArbiter.settleRead(token, false, performance.now())) return;
    if (text.length === 0) return;
    const encoded = this.core.encodePaste(text);
    if (encoded.length > 0) this.options.onData(encoded);
  }

  hasSelection(): boolean {
    return this.core.selectionText().length > 0;
  }

  getSelection(): string {
    return this.core.selectionText();
  }

  getSelectionPosition(): GhosttySelectionPosition | null {
    if (!this.selectionAnchorScreen || !this.selectionEndScreen || !this.hasSelection())
      return null;
    const before =
      this.selectionAnchorScreen.y < this.selectionEndScreen.y ||
      (this.selectionAnchorScreen.y === this.selectionEndScreen.y &&
        this.selectionAnchorScreen.x <= this.selectionEndScreen.x);
    return before
      ? { start: this.selectionAnchorScreen, end: this.selectionEndScreen }
      : { start: this.selectionEndScreen, end: this.selectionAnchorScreen };
  }

  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null {
    const position = this.getSelectionPosition();
    if (!position) return null;
    const viewportEnd = this.core.screenPointToViewport(position.end.x, position.end.y);
    if (!viewportEnd) return null;
    const bounds = this.canvas.getBoundingClientRect();
    return {
      right: bounds.left + CONTENT_PADDING + (viewportEnd.x + 1) * this.metrics.width,
      bottom: bounds.top + this.originY + (viewportEnd.y + 1) * this.metrics.height,
    };
  }

  clearSelection(): void {
    this.clearPrimedCopy();
    this.core.clearSelection();
    this.selectionEnd = null;
    this.selectionAnchorScreen = null;
    this.selectionEndScreen = null;
    this.selectionMode = 'cell';
    this.selectionBase = null;
    this.setSelectionAutoscroll(0);
    this.options.onSelectionChange?.();
    this.forceFullRender = true;
    this.requestRender();
  }

  scrollToBottom(): void {
    this.core.scrollToBottom();
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  isAtBottom(): boolean {
    return this.core.isViewportActive();
  }

  refresh(): void {
    if (this.disposed) return;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  scrollLines(deltaRows: number): void {
    if (this.disposed) return;
    this.scrollViewport(deltaRows);
  }

  selectWordAt(clientX: number, clientY: number): boolean {
    if (this.disposed) return false;
    const cell = this.cellAt(clientX, clientY);
    const range = this.core.selectWord(cell.x, cell.y);
    if (!range) return false;
    this.selectionMode = 'word';
    this.selectionMoved = false;
    this.selectionBase = range.screen;
    this.selectionEnd = range.viewport.end;
    this.selectionAnchorScreen = range.screen.start;
    this.selectionEndScreen = range.screen.end;
    this.options.onSelectionChange?.();
    this.forceFullRender = true;
    this.requestRender();
    return true;
  }

  extendSelectionTo(clientX: number, clientY: number): void {
    if (this.disposed || this.selectionAnchorScreen === null) return;
    const cell = this.cellAt(clientX, clientY);
    if (cell.x === this.selectionEnd?.x && cell.y === this.selectionEnd.y) return;
    this.extendSelectionToPoint(clientX, clientY);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    document.fonts.removeEventListener('loadingdone', this.onFontsLoaded);
    this.dprMedia?.removeEventListener('change', this.onDevicePixelRatioChange);
    this.dprMedia = null;
    this.reducedMotionMedia?.removeEventListener('change', this.onReducedMotionChange);
    if (this.selectionScrollTimer !== null) window.clearInterval(this.selectionScrollTimer);
    if (this.resizeNotifyTimer !== null) {
      window.clearTimeout(this.resizeNotifyTimer);
      this.resizeNotifyTimer = null;
      this.options.onResize(this.cols, this.rows);
    }
    this.cancelRender();
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
    }
    this.removeEvents();
    this.core.dispose();
    if (
      this.canvas.parentElement === this.mount ||
      this.input.parentElement === this.mount ||
      this.preedit.parentElement === this.mount ||
      this.scrollbar.parentElement === this.mount
    ) {
      this.canvas.remove();
      this.input.remove();
      this.preedit.remove();
      this.scrollbar.remove();
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    this.middleClickPasteAt = null;
    this.restoreRestingCaret();
    this.updateLinkModifier(event);
    if (isTerminalAltGraphText(event) || this.options.beforeKey?.(event) === false) {
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    if (isTerminalCopyShortcut(event) && this.hasSelection()) {
      const selection = this.getSelection();
      this.primeCopy(selection);
      if (event.shiftKey) {
        event.preventDefault();
        document.execCommand('copy');
      } else {
        this.clearSelectionAfterCopy = !event.shiftKey && !isMacPlatform(navigator.platform);
        const clipboard = navigator.clipboard;
        if (clipboard) {
          const token = ++this.copyShortcutToken;
          void Promise.resolve().then(() => {
            if (this.disposed || this.copyShortcutToken !== token) return;
            void clipboard.writeText(selection).then(
              () => {
                if (this.disposed || this.copyShortcutToken !== token) return;
                if (this.clearSelectionAfterCopy) {
                  this.clearSelectionAfterCopy = false;
                  this.clearSelection();
                }
              },
              () => {
                if (this.copyShortcutToken === token) {
                  this.clearSelectionAfterCopy = false;
                }
              },
            );
          });
        }
      }
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    if (isTerminalPasteShortcut(event)) {
      this.suppressedKeyCodes.add(event.code);
      const clipboard = navigator.clipboard;
      if (clipboard) {
        const token = this.pasteArbiter.beginRead();
        void clipboard.readText().then(
          (text) => {
            if (this.disposed) return;
            if (!this.pasteArbiter.settleRead(token, text.length > 0, performance.now())) return;
            if (text.length > 0) this.options.onData(this.core.encodePaste(text));
          },
          () => {
            // Clipboard read denied; the native paste event remains the path.
          },
        );
      }
      return;
    }
    const compositionKey = isTerminalCompositionKey(event, this.composing);
    const lineShortcut = compositionKey ? null : encodeMacLineShortcut(event, navigator.platform);
    const viewportScroll = compositionKey ? null : terminalViewportScrollShortcut(event, navigator.platform);
    const shellShortcut = (lineShortcut !== null || viewportScroll !== null) && this.core.supportsShellShortcuts();
    if (lineShortcut !== null && shellShortcut) {
      this.suppressedKeyCodes.add(event.code);
      event.preventDefault();
      event.stopPropagation();
      this.options.onData(lineShortcut);
      return;
    }
    if (viewportScroll !== null && shellShortcut) {
      const state = this.readScrollbarState();
      if (state !== null) {
        const page = Math.max(1, state.len);
        this.scrollViewport({
          top: -state.offset,
          bottom: state.total - state.len - state.offset,
          'page-up': -page,
          'page-down': page,
        }[viewportScroll]);
      }
      this.suppressedKeyCodes.add(event.code);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isTerminalMacAppShortcut(event) || isTerminalZoomShortcut(event)) {
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    if (compositionKey) return;
    this.clearPrimedCopy();
    const wordShortcut = this.core.encodeMacWordShortcut(event, navigator.platform);
    const data = wordShortcut ?? this.core.encodeKey(event, navigator.platform);
    if (data.length === 0) return;
    if (wordShortcut !== null) this.suppressedKeyCodes.add(event.code);
    else this.suppressedKeyCodes.delete(event.code);
    event.preventDefault();
    event.stopPropagation();
    this.options.onData(data);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.updateLinkModifier(event);
    if (this.suppressedKeyCodes.delete(event.code)) return;
    if (isTerminalCompositionKey(event, this.composing)) {
      return;
    }
    const data = this.core.encodeKey(event, navigator.platform, 'release');
    if (data.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.options.onData(data);
  };

  private readonly onFocus = () => {
    this.focused = true;
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onBlur = () => {
    this.focused = false;
    this.linkModifierActive = false;
    this.refreshHoveredLink();
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onDevicePixelRatioChange = () => {
    this.watchDevicePixelRatio();
    this.fit();
  };

  private watchDevicePixelRatio(): void {
    this.dprMedia?.removeEventListener('change', this.onDevicePixelRatioChange);
    this.dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprMedia.addEventListener('change', this.onDevicePixelRatioChange);
  }

  private primeCopy(selection: string): void {
    if (this.composing) return;
    this.primedCopySelection = selection;
    if (selection.length === 0) {
      this.resetInput();
      return;
    }
    primeTerminalCopyInput(this.input, selection);
  }

  private clearPrimedCopy(): void {
    clearPrimedTerminalCopyInput(this.input, this.primedCopySelection, this.restingInputValue);
    this.primedCopySelection = '';
  }

  private resetInput(): void {
    this.input.value = this.restingInputValue;
    const end = this.restingInputValue.length;
    if (end > 0) this.input.setSelectionRange(end, end);
  }

  private restoreRestingCaret(): void {
    const end = this.restingInputValue.length;
    if (end === 0 || this.input.value !== this.restingInputValue) return;
    if (this.input.selectionStart !== end || this.input.selectionEnd !== end) {
      this.input.setSelectionRange(end, end);
    }
  }

  private typedInput(): string {
    const value = this.input.value;
    const resting = this.restingInputValue;
    if (resting.length === 0) return value;
    const caret = this.input.selectionEnd;
    if (caret < value.length && value.slice(caret) === resting) return value.slice(0, caret);
    if (value.startsWith(resting)) return value.slice(resting.length);
    return value;
  }

  private readonly onCopyEvent = (event: ClipboardEvent) => {
    const fieldText = this.input.value === this.restingInputValue ? '' : this.input.value;
    const selection = this.hasSelection() ? this.getSelection() : fieldText;
    this.primeCopy(selection);
    const result = applyTerminalCopyEvent(selection, event.clipboardData);
    if (result.preventDefault) event.preventDefault();
    if (result.claimWriteFallback) {
      this.copyShortcutToken += 1;
      if (this.clearSelectionAfterCopy) {
        this.clearSelectionAfterCopy = false;
        this.clearSelection();
      }
    }
  };

  private readonly onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    const middleClickPasteAt = this.middleClickPasteAt;
    this.middleClickPasteAt = null;
    if (
      middleClickPasteAt !== null
      && event.timeStamp >= middleClickPasteAt
      && event.timeStamp - middleClickPasteAt <= MIDDLE_CLICK_PASTE_WINDOW_MS
    ) {
      return;
    }
    const data = event.clipboardData?.getData('text/plain') ?? '';
    if (data.length === 0) return;
    if (!this.pasteArbiter.settleNativePaste(performance.now())) return;
    this.options.onData(this.core.encodePaste(data));
  };

  private readonly onCompositionStart = () => {
    this.clearPrimedCopy();
    this.clearCompositionInputSuppression();
    this.composing = true;
  };

  private readonly onCompositionUpdate = (event: CompositionEvent) => {
    this.showPreedit(event.data);
  };

  private readonly onCompositionEnd = (event: CompositionEvent) => {
    this.composing = false;
    this.showPreedit('');
    const data = this.typedInput() || event.data;
    if (data.length > 0) this.options.onData(data);
    this.resetInput();
    this.compositionInputToSuppress = data;
    this.compositionSuppressionTimer = window.setTimeout(() => {
      this.compositionInputToSuppress = null;
      this.compositionSuppressionTimer = null;
    }, 100);
  };

  private readonly onInput = (event: Event) => {
    // SAFETY: registered for the textarea's "input" event, which is dispatched as an InputEvent.
    const inputEvent = event as InputEvent;
    if (this.composing || inputEvent.isComposing) return;
    if (this.restingInputValue.length > 0 && inputEvent.inputType === 'deleteContentBackward') {
      this.clearCompositionInputSuppression();
      this.resetInput();
      this.sendBackspace();
      return;
    }
    const data = this.typedInput() || inputEvent.data || '';
    if (data === this.compositionInputToSuppress && isTerminalCompositionCommitInput(inputEvent)) {
      this.clearCompositionInputSuppression();
      this.resetInput();
      return;
    }
    this.clearCompositionInputSuppression();
    if (data.length > 0) this.options.onData(data);
    this.resetInput();
  };

  private sendBackspace(): void {
    const key = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace' });
    const data = this.core.encodeKey(key, navigator.platform)
      + this.core.encodeKey(key, navigator.platform, 'release');
    if (data.length > 0) this.options.onData(data);
  }

  private clearCompositionInputSuppression(): void {
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
      this.compositionSuppressionTimer = null;
    }
    this.compositionInputToSuppress = null;
  }

  private ignoresTouchPointer(event: PointerEvent): boolean {
    if (event.pointerType !== 'touch' || this.options.handleTouchPointer !== false) return false;
    this.lastTouchPointerAt = event.timeStamp;
    return true;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (this.ignoresTouchPointer(event)) return;
    const mouseTracking = this.core.isMouseTracking();
    const onMiddleClickPaste = this.options.onMiddleClickPaste;
    const middleClick = event.button === 1;
    const shiftBypassesMouse = middleClick && event.shiftKey;
    const reportsMouse = shouldReportTerminalMouse(mouseTracking, event);
    const suppressesNativeMiddleClickPaste = Boolean(onMiddleClickPaste)
      && middleClick
      && !event.ctrlKey
      && !event.metaKey;
    const pastesPrimary = suppressesNativeMiddleClickPaste
      && (!mouseTracking || shiftBypassesMouse);
    this.middleClickPasteAt = suppressesNativeMiddleClickPaste ? event.timeStamp : null;
    this.focus();
    if (pastesPrimary) {
      event.preventDefault();
      event.stopPropagation();
      this.canvas.setPointerCapture(event.pointerId);
      onMiddleClickPaste?.();
      return;
    }
    if (reportsMouse) {
      const button = ghosttyMouseButton(event.button);
      if (button === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.clearHoveredLink('default');
      this.mouseReportingPointerId = event.pointerId;
      this.mouseReportingButton = button;
      this.sendMouse('press', button, event);
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    if (isTerminalLinkPointerGesture(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    this.clearHoveredLink();
    const cell = this.cellAt(event.clientX, event.clientY);
    this.selectionMoved = false;
    this.selectionClickSequence = advanceTerminalSelectionClickSequence(
      this.selectionClickSequence,
      event,
    );
    const clickCount = this.selectionClickSequence.count;
    this.selectionMode = clickCount >= 3 ? 'line' : clickCount === 2 ? 'word' : 'cell';
    const range =
      this.selectionMode === 'line'
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === 'word'
          ? this.core.selectWord(cell.x, cell.y)
          : null;
    if (range) {
      this.selectionBase = range.screen;
      this.selectionEnd = range.viewport.end;
      this.selectionAnchorScreen = range.screen.start;
      this.selectionEndScreen = range.screen.end;
      this.options.onSelectionChange?.();
    } else {
      this.selectionMode = 'cell';
      this.selectionBase = null;
      this.selectionEnd = cell;
      const screen = this.core.viewportPointToScreen(cell.x, cell.y);
      this.selectionAnchorScreen = screen;
      this.selectionEndScreen = screen;
      if (screen) {
        this.core.setSelection({ ...screen, tag: 2 }, { ...screen, tag: 2 });
      } else {
        this.core.setSelection(cell, cell);
      }
    }
    this.forceFullRender = true;
    this.canvas.setPointerCapture(event.pointerId);
    this.requestRender();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.ignoresTouchPointer(event)) return;
    if (this.linkActivationPointerId === event.pointerId) return;
    const anyEventTracking = this.synchronizeMouseTrackingState();
    if (
      this.mouseReportingPointerId === event.pointerId ||
      shouldReportTerminalMouse(anyEventTracking, event)
    ) {
      event.preventDefault();
      this.hoverPointer = { x: event.clientX, y: event.clientY };
      this.linkModifierActive = isTerminalLinkPointerGesture(event);
      this.setHoveredLink(null);
      this.canvas.style.cursor = 'default';
      this.sendMouse('motion', this.buttonFromButtons(event.buttons), event);
      return;
    }
    this.lastMouseMotionData = '';
    if (!(event.buttons & 1) || !this.selectionAnchorScreen || !this.canvas.hasPointerCapture(event.pointerId)) {
      this.updateHoverCursor(event);
      return;
    }
    this.clearHoveredLink();
    this.selectionPointer = { x: event.clientX, y: event.clientY };
    const bounds = this.canvas.getBoundingClientRect();
    this.setSelectionAutoscroll(
      event.clientY < bounds.top ? -1 : event.clientY > bounds.bottom ? 1 : 0,
    );
    const cell = this.cellAt(event.clientX, event.clientY);
    if (cell.x === this.selectionEnd?.x && cell.y === this.selectionEnd.y) return;
    this.extendSelectionToPoint(event.clientX, event.clientY);
  };

  private extendSelectionToPoint(clientX: number, clientY: number): void {
    const anchorScreen = this.selectionAnchorScreen;
    if (anchorScreen === null) return;
    const cell = this.cellAt(clientX, clientY);
    this.selectionMoved = true;
    this.selectionEnd = cell;
    const range =
      this.selectionMode === 'line'
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === 'word'
          ? this.core.selectWord(cell.x, cell.y)
          : null;
    const cellScreen = this.core.viewportPointToScreen(cell.x, cell.y);
    if (cellScreen === null) return;
    const base = this.selectionBase;
    const beforeBase =
      base !== null &&
      (cellScreen.y < base.start.y ||
        (cellScreen.y === base.start.y && cellScreen.x < base.start.x));
    const anchor = base === null ? anchorScreen : beforeBase ? base.end : base.start;
    const end = range === null ? cellScreen : beforeBase ? range.screen.start : range.screen.end;
    this.selectionAnchorScreen = anchor;
    this.selectionEndScreen = end;
    this.core.setSelection({ ...anchor, tag: 2 }, { ...end, tag: 2 });
    this.options.onSelectionChange?.();
    this.forceFullRender = true;
    this.requestRender();
  }

  private setSelectionAutoscroll(delta: number): void {
    this.selectionScrollDelta = delta;
    if (delta === 0) {
      if (this.selectionScrollTimer !== null) {
        window.clearInterval(this.selectionScrollTimer);
        this.selectionScrollTimer = null;
      }
      return;
    }
    if (this.selectionScrollTimer !== null) return;
    this.selectionScrollTimer = window.setInterval(() => {
      if (this.disposed || this.selectionScrollDelta === 0) return;
      this.scrollViewport(this.selectionScrollDelta);
      const pointer = this.selectionPointer;
      if (pointer) this.extendSelectionToPoint(pointer.x, pointer.y);
    }, 80);
  }

  private updateHoverCursor(event: PointerEvent): void {
    this.hoverPointer = { x: event.clientX, y: event.clientY };
    this.linkModifierActive = isTerminalLinkPointerGesture(event);
    this.refreshHoveredLink();
  }

  private updateLinkModifier(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>): void {
    const active = isTerminalLinkPointerGesture(event);
    if (active === this.linkModifierActive) return;
    this.linkModifierActive = active;
    this.refreshHoveredLink();
  }

  private readonly onPointerLeave = () => {
    this.lastMouseMotionData = '';
    this.clearHoveredLink();
  };

  private clearHoveredLink(cursor = ''): void {
    this.hoverPointer = null;
    this.setHoveredLink(null);
    this.canvas.style.cursor = cursor;
  }

  private refreshHoveredLink(): void {
    const pointer = this.hoverPointer;
    const link = pointer && this.linkModifierActive ? this.linkAt(pointer.x, pointer.y) : null;
    this.setHoveredLink(link);
  }

  private setHoveredLink(link: TerminalLinkWithRange | null): void {
    const previous = this.hoveredLink;
    const unchanged =
      previous?.text === link?.text &&
      previous?.range.start.x === link?.range.start.x &&
      previous?.range.start.y === link?.range.start.y &&
      previous?.range.end.x === link?.range.end.x &&
      previous?.range.end.y === link?.range.end.y;
    this.canvas.style.cursor = link ? 'pointer' : '';
    if (unchanged) return;
    this.hoveredLink = link;
    this.forceFullRender = true;
    this.requestRender();
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.ignoresTouchPointer(event)) return;
    if (event.type === 'pointercancel') {
      this.middleClickPasteAt = null;
    } else if (event.button === 1 && this.middleClickPasteAt !== null) {
      this.middleClickPasteAt = event.timeStamp;
    }
    this.setSelectionAutoscroll(0);
    if (this.linkActivationPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (event.type !== 'pointercancel') {
        const link = this.linkAt(event.clientX, event.clientY);
        if (link) this.options.onLinkActivate?.(link.text, event);
      }
      return;
    }
    if (this.mouseReportingPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.sendMouse('release', this.mouseReportingButton, event);
      this.mouseReportingPointerId = null;
      this.mouseReportingButton = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (event.type === 'pointercancel') {
        this.clearHoveredLink();
      } else {
        this.hoverPointer = { x: event.clientX, y: event.clientY };
        this.linkModifierActive = isTerminalLinkPointerGesture(event);
        this.refreshHoveredLink();
      }
      return;
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.button !== 0) return;
    if (!this.selectionMoved && this.selectionMode === 'cell') {
      this.clearSelection();
    }
    this.options.onSelectionChange?.();
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const delta = terminalWheelDeltaRows(
      event,
      this.metrics.height,
      this.rows,
      this.wheelRemainder,
    );
    this.wheelRemainder = delta.remainder;
    if (delta.rows === 0) return;
    const magnitude = Math.abs(delta.rows);
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      const button = delta.rows < 0 ? 4 : 5;
      for (let index = 0; index < magnitude; index += 1) {
        this.sendMouse('press', button, event);
      }
      return;
    }
    if (this.core.isAlternateScreen()) {
      this.options.onData(terminalWheelArrowData(delta.rows, this.core.isApplicationCursorKeys()));
      return;
    }
    this.scrollViewport(delta.rows);
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) event.preventDefault();
    if (event.timeStamp - this.lastTouchPointerAt < TOUCH_MOUSE_COMPAT_WINDOW_MS) return;
    this.focus();
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      event.preventDefault();
      return;
    }
    this.options.onContextMenu?.(event);
  };

  private readonly onScrollbarPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const state = this.readScrollbarState();
    if (state === null) return;
    const bounds = this.scrollbar.getBoundingClientRect();
    const geometry = terminalScrollbarGeometry(state, bounds.height);
    if (geometry === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.scrollbarPointerId = event.pointerId;
    this.scrollbarPointerOffset =
      event.target === this.scrollbarThumb
        ? event.clientY - bounds.top - geometry.thumbTop
        : geometry.thumbHeight / 2;
    this.scrollbar.setPointerCapture(event.pointerId);
    this.scrollbarToPointer(event.clientY, bounds);
  };

  private readonly onScrollbarPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId || this.scrollbarState === null) return;
    event.preventDefault();
    this.scrollbarToPointer(event.clientY, this.scrollbar.getBoundingClientRect());
  };

  private readonly onScrollbarPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId) return;
    event.preventDefault();
    this.scrollbarPointerId = null;
    if (this.scrollbar.hasPointerCapture(event.pointerId)) {
      this.scrollbar.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onScrollbarKeyDown = (event: KeyboardEvent) => {
    const state = this.readScrollbarState();
    if (state === null) return;
    let delta = 0;
    switch (event.key) {
      case 'ArrowUp':
        delta = -1;
        break;
      case 'ArrowDown':
        delta = 1;
        break;
      case 'PageUp':
        delta = -Math.max(1, state.len);
        break;
      case 'PageDown':
        delta = Math.max(1, state.len);
        break;
      case 'Home':
        delta = -state.offset;
        break;
      case 'End':
        delta = state.total - state.len - state.offset;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.scrollViewport(delta);
  };

  private installEvents(): void {
    this.input.addEventListener('keydown', this.onKeyDown);
    this.input.addEventListener('keyup', this.onKeyUp);
    this.input.addEventListener('focus', this.onFocus);
    this.input.addEventListener('blur', this.onBlur);
    this.input.addEventListener('input', this.onInput);
    this.input.addEventListener('paste', this.onPaste);
    this.input.addEventListener('copy', this.onCopyEvent);
    this.input.addEventListener('compositionstart', this.onCompositionStart);
    this.input.addEventListener('compositionupdate', this.onCompositionUpdate);
    this.input.addEventListener('compositionend', this.onCompositionEnd);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.scrollbar.addEventListener('pointerdown', this.onScrollbarPointerDown);
    this.scrollbar.addEventListener('pointermove', this.onScrollbarPointerMove);
    this.scrollbar.addEventListener('pointerup', this.onScrollbarPointerUp);
    this.scrollbar.addEventListener('pointercancel', this.onScrollbarPointerUp);
    this.scrollbar.addEventListener('keydown', this.onScrollbarKeyDown);
  }

  private removeEvents(): void {
    this.input.removeEventListener('keydown', this.onKeyDown);
    this.input.removeEventListener('keyup', this.onKeyUp);
    this.input.removeEventListener('focus', this.onFocus);
    this.input.removeEventListener('blur', this.onBlur);
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('paste', this.onPaste);
    this.input.removeEventListener('copy', this.onCopyEvent);
    this.input.removeEventListener('compositionstart', this.onCompositionStart);
    this.input.removeEventListener('compositionupdate', this.onCompositionUpdate);
    this.input.removeEventListener('compositionend', this.onCompositionEnd);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.scrollbar.removeEventListener('pointerdown', this.onScrollbarPointerDown);
    this.scrollbar.removeEventListener('pointermove', this.onScrollbarPointerMove);
    this.scrollbar.removeEventListener('pointerup', this.onScrollbarPointerUp);
    this.scrollbar.removeEventListener('pointercancel', this.onScrollbarPointerUp);
    this.scrollbar.removeEventListener('keydown', this.onScrollbarKeyDown);
  }

  private scrollViewport(deltaRows: number): void {
    let delta = Math.trunc(deltaRows);
    const state = this.readScrollbarState();
    if (state !== null) {
      const maxOffset = Math.max(0, state.total - state.len);
      const offset = Math.max(0, Math.min(state.offset + delta, maxOffset));
      delta = offset - state.offset;
      this.scrollbarState = { ...state, offset };
    }
    if (delta === 0) return;
    this.core.scroll(delta);
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  private scrollbarToPointer(clientY: number, bounds: DOMRect): void {
    const state = this.scrollbarState;
    if (state === null) return;
    const offset = terminalScrollbarOffsetAtPointer(
      state,
      bounds.height,
      clientY - bounds.top,
      this.scrollbarPointerOffset,
    );
    this.scrollViewport(offset - state.offset);
  }

  private updateScrollbar(): void {
    const state = this.readScrollbarState();
    const geometry =
      state === null
        ? null
        : terminalScrollbarGeometry(
            state,
            Math.max(0, this.mount.clientHeight - CONTENT_PADDING * 2),
          );
    this.scrollbar.hidden = geometry === null;
    if (state === null || geometry === null) return;
    this.scrollbar.setAttribute('aria-valuemin', '0');
    this.scrollbar.setAttribute('aria-valuemax', String(geometry.maxOffset));
    this.scrollbar.setAttribute(
      'aria-valuenow',
      String(Math.max(0, Math.min(state.offset, geometry.maxOffset))),
    );
    this.scrollbarThumb.style.height = `${geometry.thumbHeight}px`;
    this.scrollbarThumb.style.transform = `translateY(${geometry.thumbTop}px)`;
  }

  private readScrollbarState(): GhosttyScrollbar | null {
    const state = this.core.scrollbarState();
    this.scrollbarState = state;
    return state;
  }

  private requestRender(): void {
    if (this.disposed || !this.visible || !this.hasSize || this.frame !== 0) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.renderFrame();
    });
  }

  private cancelRender(): void {
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.cursorTimer !== null) {
      window.clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
  }

  private renderFrame(): void {
    if (this.disposed || !this.visible) return;
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.mount.clientWidth === 0 || this.mount.clientHeight === 0) {
      this.hasSize = false;
      this.forceFullRender = true;
      this.cancelRender();
      return;
    }
    this.snapshot = this.core.snapshot();
    if (!this.blinkEnabled()) this.cursorOn = true;
    const scrollState = this.readScrollbarState();
    const anchorBottom = scrollState !== null && scrollState.total > scrollState.len;
    const nextOriginY = terminalContentOriginY(
      this.mountHeight,
      CONTENT_PADDING,
      this.rows,
      this.metrics.height,
      anchorBottom,
    );
    if (nextOriginY !== this.originY) {
      this.originY = nextOriginY;
      this.forceFullRender = true;
    }
    this.refreshHoveredLink();
    renderGhosttySnapshot({
      context: this.context,
      snapshot: this.snapshot,
      metrics: this.metrics,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      padding: CONTENT_PADDING,
      originY: this.originY,
      forceFull: this.forceFullRender,
      cursorOn: this.cursorOn,
      previousCursorY: this.renderedCursorY,
      focused: this.focused,
      hoveredLinkRange: this.hoveredLink?.range ?? null,
      selectionBackground: this.theme.selectionBackground,
    });
    this.positionInput();
    this.positionPreedit();
    this.renderedCursorY =
      this.cursorOn && this.snapshot.cursorVisible && this.snapshot.cursorY >= 0
        ? this.snapshot.cursorY
        : null;
    if (this.scrollbarDirty) {
      this.scrollbarDirty = false;
      this.updateScrollbar();
    }
    this.forceFullRender = false;
    this.scheduleCursorBlink();
  }

  private scheduleCursorBlink(): void {
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    if (!this.blinkEnabled()) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      this.cursorOn = !this.cursorOn;
      this.requestRender();
    }, CURSOR_BLINK_INTERVAL_MS);
  }

  private blinkEnabled(): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || !this.visible || !this.hasSize) return false;
    return shouldBlinkTerminalCursor({
      focused: this.focused,
      cursorBlinking: snapshot.cursorBlinking,
      cursorVisible: snapshot.cursorVisible,
      reducedMotion: this.reducedMotionMedia?.matches ?? false,
    });
  }

  private positionInput(): void {
    const snapshot = this.snapshot;
    if (!snapshot || !snapshot.cursorVisible || snapshot.cursorX < 0 || snapshot.cursorY < 0) {
      return;
    }
    const left = CONTENT_PADDING + snapshot.cursorX * this.metrics.width;
    const top = this.originY + snapshot.cursorY * this.metrics.height;
    if (left === this.inputLeft && top === this.inputTop) return;
    this.inputLeft = left;
    this.inputTop = top;
    this.input.style.left = `${left}px`;
    this.input.style.top = `${top}px`;
    this.input.style.height = `${this.metrics.height}px`;
  }

  private stylePreedit(): void {
    const { foreground, background } = this.theme;
    const { style } = this.preedit;
    style.font = `${this.fontSize}px ${this.fontFamily}`;
    style.lineHeight = `${this.metrics.height}px`;
    style.color = `rgb(${foreground.r}, ${foreground.g}, ${foreground.b})`;
    style.backgroundColor = `rgb(${background.r}, ${background.g}, ${background.b})`;
  }

  private showPreedit(text: string): void {
    this.preedit.textContent = text;
    this.preedit.hidden = text.length === 0;
    this.positionPreedit();
  }

  private positionPreedit(): void {
    if (this.preedit.hidden) return;
    const cursorX = this.snapshot?.cursorX ?? -1;
    const cursorY = this.snapshot?.cursorY ?? -1;
    const onScreen = cursorX >= 0 && cursorY >= 0;
    this.preedit.style.visibility = onScreen ? '' : 'hidden';
    if (!onScreen) return;
    const cursorLeft = CONTENT_PADDING + cursorX * this.metrics.width;
    const maxLeft = this.mount.clientWidth - CONTENT_PADDING - this.preedit.offsetWidth;
    const left = Math.max(CONTENT_PADDING, Math.min(cursorLeft, maxLeft));
    this.preedit.style.left = `${Math.floor(left)}px`;
    this.preedit.style.top = `${this.originY + cursorY * this.metrics.height}px`;
    this.preedit.scrollLeft = this.preedit.scrollWidth;
  }

  private cellAt(clientX: number, clientY: number): GhosttyGridPoint {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          this.cols - 1,
          Math.floor((clientX - bounds.left - CONTENT_PADDING) / this.metrics.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          this.rows - 1,
          Math.floor((clientY - bounds.top - this.originY) / this.metrics.height),
        ),
      ),
    };
  }

  private linkAt(clientX: number, clientY: number): TerminalLinkWithRange | null {
    if (!this.snapshot) return null;
    const cell = terminalGridCellAt({
      bounds: this.canvas.getBoundingClientRect(),
      clientX,
      clientY,
      cols: this.cols,
      rows: this.rows,
      metrics: this.metrics,
      padding: CONTENT_PADDING,
      originY: this.originY,
    });
    if (!cell) return null;
    const explicitHyperlink = this.core.hyperlinkAt(cell.x, cell.y);
    if (explicitHyperlink) {
      const start = { ...cell };
      const end = { ...cell };
      while (true) {
        const previous =
          start.x > 0
            ? { x: start.x - 1, y: start.y }
            : start.y > 0 && this.snapshot.rowData[start.y]?.isWrapContinuation
              ? { x: this.cols - 1, y: start.y - 1 }
              : null;
        if (!previous || this.core.hyperlinkAt(previous.x, previous.y) !== explicitHyperlink) break;
        start.x = previous.x;
        start.y = previous.y;
      }
      while (true) {
        const next =
          end.x + 1 < this.cols
            ? { x: end.x + 1, y: end.y }
            : end.y + 1 < this.rows && this.snapshot.rowData[end.y]?.wrapsToNext
              ? { x: 0, y: end.y + 1 }
              : null;
        if (!next || this.core.hyperlinkAt(next.x, next.y) !== explicitHyperlink) break;
        end.x = next.x;
        end.y = next.y;
      }
      return {
        text: explicitHyperlink,
        range: { start, end },
      };
    }
    return terminalLinkAtPositionWithRange(this.snapshot.rowData, cell.y, cell.x);
  }

  private sendMouse(action: TerminalMouseAction, button: number | null, event: MouseEvent): void {
    const bounds = this.canvas.getBoundingClientRect();
    const data = this.core.encodeMouse({
      action,
      button,
      mods:
        (event.shiftKey ? 1 : 0) |
        (event.ctrlKey ? 1 << 1 : 0) |
        (event.altKey ? 1 << 2 : 0) |
        (event.metaKey ? 1 << 3 : 0),
      x: Math.max(0, event.clientX - bounds.left),
      y: Math.max(0, event.clientY - bounds.top),
      screenWidth: bounds.width,
      screenHeight: bounds.height,
      cellWidth: this.metrics.width,
      cellHeight: this.metrics.height,
      paddingLeft: CONTENT_PADDING,
      paddingRight: CONTENT_PADDING,
      paddingTop: this.originY,
      paddingBottom: Math.max(0, bounds.height - this.originY - this.rows * this.metrics.height),
      anyButtonPressed: event.buttons !== 0,
    });
    const resolution = resolveTerminalMouseData(action, data, this.lastMouseMotionData);
    this.lastMouseMotionData = resolution.nextMotionData;
    if (resolution.send) this.options.onData(data);
  }

  private synchronizeMouseTrackingState(): boolean {
    const tracking = this.core.isMouseAnyEventTracking();
    const state = resolveTerminalMouseTrackingState(
      this.mouseAnyEventTracking,
      tracking,
      this.lastMouseMotionData,
    );
    this.mouseAnyEventTracking = state.tracking;
    this.lastMouseMotionData = state.motionData;
    return tracking;
  }

  private buttonFromButtons(buttons: number): number | null {
    if ((buttons & 1) !== 0) return 1;
    if ((buttons & 4) !== 0) return 3;
    if ((buttons & 2) !== 0) return 2;
    if ((buttons & 8) !== 0) return 4;
    if ((buttons & 16) !== 0) return 5;
    return null;
  }
}
