import type { JsonValue } from './contract.ts';

export const GUEST_POPOVER_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const GUEST_POPOVER_COORDINATE_MAX = 100_000;
export const GUEST_POPOVER_WIDTH_MIN = 160;
export const GUEST_POPOVER_WIDTH_MAX = 640;
export const GUEST_POPOVER_HEIGHT_MIN = 48;
export const GUEST_POPOVER_HEIGHT_MAX = 480;
export const GUEST_POPOVER_DATA_MAX = 16_000;
export const GUEST_POPOVER_DATA_DEPTH_MAX = 32;
export const GUEST_POPOVER_SIDES = ['left', 'right', 'top', 'bottom'] as const;

export type GuestPopoverSide = (typeof GUEST_POPOVER_SIDES)[number];
export type GuestPopoverAnchor = { x: number; y: number; width: number; height: number };
export type GuestPopoverRequest = {
  id: string;
  anchor: GuestPopoverAnchor;
  width: number;
  height: number;
  side?: GuestPopoverSide;
  focus?: boolean;
  data: JsonValue;
};
export type GuestPopoverContext = { id: string; data: JsonValue };
export const GUEST_POPOVER_CLOSE_REASONS = ['escape', 'outside', 'anchor', 'owner', 'closed', 'replaced'] as const;
export type GuestPopoverClosedEvent = { id: string; reason: (typeof GUEST_POPOVER_CLOSE_REASONS)[number] };

const hasBoundedJsonTree = (value: JsonValue, depth = 0, budget = { remaining: GUEST_POPOVER_DATA_MAX }): boolean => {
  if (--budget.remaining < 0 || depth >= GUEST_POPOVER_DATA_DEPTH_MAX) return false;
  if (value === null) return true;
  const children = Array.isArray(value) ? value : Object(value) === value ? Object.values(value) : [];
  for (const item of children) {
    if (!hasBoundedJsonTree(item, depth + 1, budget)) return false;
  }
  return true;
};

// Used only after the depth bound above, including for JavaScript consumers
// whose values need not satisfy the public JsonValue type.
const isFiniteJson = (value: JsonValue): boolean => {
  if (value === null || value === true || value === false) return true;
  if (Array.isArray(value)) return Object.keys(value).every((key) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)
    && value.every(isFiniteJson);
  if (Object(value) === value) {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === null || prototype === Object.prototype) && Object.values(value).every(isFiniteJson);
  }
  return String(value) === value || Number.isFinite(value);
};

/** Guest-side fast-fail guard. The host schema remains authoritative for untyped callers. */
export const isGuestPopoverRequest = (request: GuestPopoverRequest): boolean => {
  try {
    if (String(request.id) !== request.id || !GUEST_POPOVER_ID.test(request.id)
    || !Number.isFinite(request.anchor.x) || Math.abs(request.anchor.x) > GUEST_POPOVER_COORDINATE_MAX
    || !Number.isFinite(request.anchor.y) || Math.abs(request.anchor.y) > GUEST_POPOVER_COORDINATE_MAX
    || !Number.isFinite(request.anchor.width) || !Number.isFinite(request.anchor.height)
    || request.anchor.width <= 0 || request.anchor.height <= 0
    || request.anchor.width > GUEST_POPOVER_COORDINATE_MAX || request.anchor.height > GUEST_POPOVER_COORDINATE_MAX
    || !Number.isInteger(request.width) || request.width < GUEST_POPOVER_WIDTH_MIN || request.width > GUEST_POPOVER_WIDTH_MAX
    || !Number.isInteger(request.height) || request.height < GUEST_POPOVER_HEIGHT_MIN || request.height > GUEST_POPOVER_HEIGHT_MAX
    || (request.side !== undefined && !GUEST_POPOVER_SIDES.includes(request.side))
    || (request.focus !== undefined && request.focus !== true && request.focus !== false)
    || !hasBoundedJsonTree(request.data) || !isFiniteJson(request.data)) return false;
    return JSON.stringify(request.data).length <= GUEST_POPOVER_DATA_MAX;
  } catch {
    return false;
  }
};
