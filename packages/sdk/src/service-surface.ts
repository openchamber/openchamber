
export const SURFACE_FRAME_PATH = '/surface/frame';
export const SURFACE_INPUT_PATH = '/surface/input';
export const SURFACE_CONTROL_PATH = '/surface/control';
export const SURFACE_RESIZE_PATH = '/surface/resize';
export const SURFACE_CLIPBOARD_PATH = '/surface/clipboard';

export const SURFACE_SEQ_HEADER = 'x-surface-seq';
export const SURFACE_WIDTH_HEADER = 'x-surface-width';
export const SURFACE_HEIGHT_HEADER = 'x-surface-height';
export const SURFACE_TITLE_HEADER = 'x-surface-title';
export const SURFACE_AGENT_ACTIVE_HEADER = 'x-surface-agent-active';
export const SURFACE_VIEWER_HEADER = 'x-surface-viewer';
export const SURFACE_FRAME_SEQ_HEADER = 'x-surface-frame-seq';
export const SURFACE_VIEWER_CONTROLS_HEADER = 'x-surface-viewer-controls';

export const SURFACE_FRAME_MIMES = ['image/jpeg', 'image/png'] as const;
export type SurfaceFrameMime = (typeof SURFACE_FRAME_MIMES)[number];

export const SURFACE_FRAME_WAIT_MS = 25_000;
export const SURFACE_FRAME_MAX_BYTES = 8_000_000;
export const SURFACE_INPUT_BATCH_MAX = 256;
export const SURFACE_TEXT_MAX = 64_000;
export const SURFACE_TITLE_MAX = 200;
export const SURFACE_DIMENSION_MAX = 16_384;
export const SURFACE_AGENT_HOLD_MS = 30_000;

export type SurfaceModifiers = { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };

export type SurfacePointerEvent = {
  type: 'pointer';
  action: 'down' | 'up' | 'move';
  x: number;
  y: number;
  button: number;
  buttons: number;
  modifiers: SurfaceModifiers;
};

export type SurfaceWheelEvent = {
  type: 'wheel';
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers: SurfaceModifiers;
};

export type SurfaceKeyEvent = {
  type: 'key';
  action: 'down' | 'up';
  key: string;
  code: string;
  keyCode?: number;
  modifiers: SurfaceModifiers;
};

export type SurfaceTextEvent = { type: 'text'; text: string };

export type SurfaceInputEvent = SurfacePointerEvent | SurfaceWheelEvent | SurfaceKeyEvent | SurfaceTextEvent;

export type SurfaceInputBatch = { events: SurfaceInputEvent[] };

export const SURFACE_CONTROLLERS = ['none', 'agent', 'user'] as const;
export type SurfaceController = (typeof SURFACE_CONTROLLERS)[number];

export type SurfaceControlNotice = {
  controller: SurfaceController;
  viewer?: string;
};

export type SurfaceResizeRequest = { width: number; height: number };
export type SurfaceResizeAnswer = { width: number; height: number };
export type SurfaceClipboardAnswer = { text: string };

const isFiniteNumber = (value: SurfaceWire[keyof SurfaceWire]): value is number => (
  Number(value) === value && Number.isFinite(value)
);
const isBool = (value: SurfaceWire[keyof SurfaceWire]): value is boolean => value === true || value === false;
const isText = (value: SurfaceWire[keyof SurfaceWire]): value is string => String(value) === value;

type SurfaceWire = {
  type?: unknown;
  action?: unknown;
  x?: unknown;
  y?: unknown;
  button?: unknown;
  buttons?: unknown;
  deltaX?: unknown;
  deltaY?: unknown;
  key?: unknown;
  code?: unknown;
  keyCode?: unknown;
  text?: unknown;
  modifiers?: unknown;
};

type ModifiersWire = { alt?: unknown; ctrl?: unknown; meta?: unknown; shift?: unknown };

const readModifiers = (value: SurfaceWire['modifiers']): SurfaceModifiers | null => {
  if (Object(value) !== value || value === null) return null;
  // SAFETY: a non-null object; each field is checked below before use.
  const wire = value as ModifiersWire;
  if (!isBool(wire.alt) || !isBool(wire.ctrl) || !isBool(wire.meta) || !isBool(wire.shift)) return null;
  return { alt: wire.alt, ctrl: wire.ctrl, meta: wire.meta, shift: wire.shift };
};

const readEvent = (value: SurfaceWire): SurfaceInputEvent | null => {
  if (value.type === 'text') {
    if (!isText(value.text) || value.text.length > SURFACE_TEXT_MAX) return null;
    return { type: 'text', text: value.text };
  }
  const modifiers = readModifiers(value.modifiers);
  if (!modifiers) return null;
  if (value.type === 'pointer') {
    if (value.action !== 'down' && value.action !== 'up' && value.action !== 'move') return null;
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.button) || !isFiniteNumber(value.buttons)) return null;
    return { type: 'pointer', action: value.action, x: value.x, y: value.y, button: value.button, buttons: value.buttons, modifiers };
  }
  if (value.type === 'wheel') {
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.deltaX) || !isFiniteNumber(value.deltaY)) return null;
    return { type: 'wheel', x: value.x, y: value.y, deltaX: value.deltaX, deltaY: value.deltaY, modifiers };
  }
  if (value.type === 'key') {
    if (value.action !== 'down' && value.action !== 'up') return null;
    if (!isText(value.key) || !isText(value.code) || value.key.length > 64 || value.code.length > 64) return null;
    if (value.keyCode === undefined) return { type: 'key', action: value.action, key: value.key, code: value.code, modifiers };
    if (!isFiniteNumber(value.keyCode) || !Number.isInteger(value.keyCode) || value.keyCode < 0 || value.keyCode > 255) return null;
    return { type: 'key', action: value.action, key: value.key, code: value.code, keyCode: value.keyCode, modifiers };
  }
  return null;
};

export const readSurfaceInputBatch = (body: string): SurfaceInputBatch | null => {
  let parsed: { events?: unknown } | null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Object(parsed) !== parsed || parsed === null || !Array.isArray(parsed.events)) return null;
  if (parsed.events.length > SURFACE_INPUT_BATCH_MAX) return null;
  const events: SurfaceInputEvent[] = [];
  for (const item of parsed.events) {
    if (Object(item) !== item || item === null) return null;
    // SAFETY: a non-null object; readEvent checks every field it reads.
    const event = readEvent(item as SurfaceWire);
    if (!event) return null;
    events.push(event);
  }
  return { events };
};

const CONTROLLERS: ReadonlySet<string> = new Set(SURFACE_CONTROLLERS);

export const readSurfaceControlNotice = (body: string): SurfaceControlNotice | null => {
  let parsed: { controller?: unknown; viewer?: unknown } | null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Object(parsed) !== parsed || parsed === null) return null;
  const { controller, viewer } = parsed;
  if (!isText(controller) || !CONTROLLERS.has(controller)) return null;
  // SAFETY: membership in SURFACE_CONTROLLERS was just checked.
  const notice: SurfaceControlNotice = { controller: controller as SurfaceController };
  if (controller === 'user' && isText(viewer) && viewer.length > 0) notice.viewer = viewer;
  return notice;
};

export const readSurfaceResizeRequest = (body: string): SurfaceResizeRequest | null => {
  let parsed: { width?: unknown; height?: unknown } | null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Object(parsed) !== parsed || parsed === null) return null;
  const { width, height } = parsed;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width < 1 || height < 1 || width > SURFACE_DIMENSION_MAX || height > SURFACE_DIMENSION_MAX) return null;
  return { width: Math.round(width), height: Math.round(height) };
};
