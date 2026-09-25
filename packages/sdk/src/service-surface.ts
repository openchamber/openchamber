/**
 * Shared surface: a service shows the host a live picture of something an
 * agent is working in (a browser, a simulator, a desktop app) and takes the
 * user's pointer and keyboard back, so a person can watch, step in for a
 * manual step, and hand control back. The host draws it in the extension's
 * rail panel; the service only produces frames and consumes input.
 *
 * Declared with `contributes.service.surface: true`. The host keeps the
 * service running while a viewer is attached and talks plain HTTP to it:
 *
 * - `GET /surface/frame?after=<seq>&wait=<ms>`: the next frame newer than
 *   `seq`, held up to `wait` ms. 200 with the image bytes (`Content-Type`
 *   `image/jpeg` or `image/png`) and the `x-surface-*` headers below; 204 when
 *   nothing newer arrived in time. Sequence numbers start at 1, so `after=0`
 *   is "the current picture, now". The host asks for one frame at a time per
 *   viewer, so a slow viewer never piles up frames: that is the backpressure.
 * - `POST /surface/input`: `{ events: SurfaceInputEvent[] }`, coordinates in
 *   frame pixels. Sent only while the user holds control. Headers name the
 *   viewer (`x-surface-viewer`) and the frame it last drew
 *   (`x-surface-frame-seq`, the service's own sequence number, `0` before the
 *   first). Answer 409 to refuse input made on a picture you no longer show.
 * - `POST /surface/control`: `{ controller, viewer? }` whenever control
 *   changes, so the service can pause its own automation while the user is
 *   in. `viewer` is the controlling viewer's id when `controller` is `user`.
 *
 * A page of the same extension open in the same window as a viewer (a
 * docked toolbar, an extension page) reaches the service with that viewer's
 * `x-surface-viewer`, `x-surface-viewer-controls` (`1` while it holds
 * control), and `x-surface-frame-seq` on every `serviceRequest`. The host
 * sets all three itself; without a viewer in that window they are absent.
 * - `POST /surface/resize`: `{ width, height }` the panel can show; the
 *   service answers the size it settled on, or 400 to keep its own.
 * - `GET /surface/clipboard`: `{ text }`, what the user copied inside the
 *   surface; the host puts it on their clipboard.
 */

export const SURFACE_FRAME_PATH = '/surface/frame';
export const SURFACE_INPUT_PATH = '/surface/input';
export const SURFACE_CONTROL_PATH = '/surface/control';
export const SURFACE_RESIZE_PATH = '/surface/resize';
export const SURFACE_CLIPBOARD_PATH = '/surface/clipboard';

export const SURFACE_SEQ_HEADER = 'x-surface-seq';
export const SURFACE_WIDTH_HEADER = 'x-surface-width';
export const SURFACE_HEIGHT_HEADER = 'x-surface-height';
export const SURFACE_TITLE_HEADER = 'x-surface-title';
/** `1` while the service's own automation (an agent) is driving the surface. */
export const SURFACE_AGENT_ACTIVE_HEADER = 'x-surface-agent-active';
/** Host → service: the host-issued id of the viewer a request comes from. */
export const SURFACE_VIEWER_HEADER = 'x-surface-viewer';
/** Host → service: the service's sequence number of the frame that viewer last drew; `0` before its first. */
export const SURFACE_FRAME_SEQ_HEADER = 'x-surface-frame-seq';
/** Host → service, on page `serviceRequest`s only: `1` while that viewer holds control, else `0`. */
export const SURFACE_VIEWER_CONTROLS_HEADER = 'x-surface-viewer-controls';

export const SURFACE_FRAME_MIMES = ['image/jpeg', 'image/png'] as const;
export type SurfaceFrameMime = (typeof SURFACE_FRAME_MIMES)[number];

/** How long the host lets one frame request wait before asking again. */
export const SURFACE_FRAME_WAIT_MS = 25_000;
export const SURFACE_FRAME_MAX_BYTES = 8_000_000;
export const SURFACE_INPUT_BATCH_MAX = 256;
export const SURFACE_TEXT_MAX = 64_000;
export const SURFACE_TITLE_MAX = 200;
export const SURFACE_DIMENSION_MAX = 16_384;
/** After an agent action the agent counts as controlling for this long. */
export const SURFACE_AGENT_HOLD_MS = 30_000;

export type SurfaceModifiers = { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };

export type SurfacePointerEvent = {
  type: 'pointer';
  action: 'down' | 'up' | 'move';
  x: number;
  y: number;
  /** 0 left, 1 middle, 2 right; `-1` for a move without a button change. */
  button: number;
  /** Bitmask of buttons held, as `MouseEvent.buttons`. */
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
  /** `KeyboardEvent.key`. */
  key: string;
  /** `KeyboardEvent.code`. */
  code: string;
  modifiers: SurfaceModifiers;
};

/** Text the user pasted or composed; type it as is. */
export type SurfaceTextEvent = { type: 'text'; text: string };

export type SurfaceInputEvent = SurfacePointerEvent | SurfaceWheelEvent | SurfaceKeyEvent | SurfaceTextEvent;

export type SurfaceInputBatch = { events: SurfaceInputEvent[] };

export const SURFACE_CONTROLLERS = ['none', 'agent', 'user'] as const;
export type SurfaceController = (typeof SURFACE_CONTROLLERS)[number];

export type SurfaceControlNotice = {
  controller: SurfaceController;
  /** The controlling viewer's id (`x-surface-viewer`), present only when `controller` is `user`. */
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
    return { type: 'key', action: value.action, key: value.key, code: value.code, modifiers };
  }
  return null;
};

/**
 * A service's read of the `POST /surface/input` body. Every event is checked
 * field by field; one bad event refuses the whole batch (`null`), which the
 * service answers with HTTP 400. No schema library needed.
 */
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

/** A service's read of the `POST /surface/control` body. */
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

/** A service's read of the `POST /surface/resize` body. */
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
