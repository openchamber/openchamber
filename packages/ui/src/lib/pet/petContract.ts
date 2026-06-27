// Cross-window contract for the desktop floating pet (Codex-pet compatible).
//
// The pet lives in its own transparent/frameless/always-on-top BrowserWindow
// (see packages/electron + packages/web/pet.html). It is a "dumb" renderer: it
// does NOT mount its own sync connection. Instead the MAIN app renderer derives
// the aggregate pet state (reusing the same live signals the macOS tray uses in
// useTraySync.ts) and broadcasts it over a same-origin BroadcastChannel. The pet
// renders it and relays user actions (e.g. answering a permission) back to the
// main renderer, which owns the live sync + actions — exactly the tray pattern.
//
// Both windows load from the same local origin, so BroadcastChannel is delivered
// across them (same mechanism as the mini-chat presence channel).

export const PET_STATE_CHANNEL = 'openchamber:pet-state';
export const PET_ACTION_CHANNEL = 'openchamber:pet-action';

// Horizontal drag direction. The pet window is dragged by the renderer (custom
// drag via desktop_pet_drag_*; the window is frameless + non-focusable so there
// is no app-region/titlebar drag), which derives the direction from the cursor
// delta and overrides the sprite with the running-left/right rows while moving.
export type PetDragDirection = 'left' | 'right';

// Sprite-sheet rows, in the fixed Codex/petdex order (8 cols x 9 rows, 192x208
// cells). Geometry is convention — pet.json carries none — so the renderer
// derives cols/rows from the image and uses this order as the row map.
export const PET_SPRITE_ROWS = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
] as const;

export type PetSpriteRow = (typeof PET_SPRITE_ROWS)[number];

// Per-row frame counts (Codex/petdex convention). pet.json declares none, so
// these are the fallback; the renderer clamps to the sheet width. idle is the
// resting loop and uses only columns 0-5; the other rows use the counts below.
export const PET_SPRITE_FRAME_COUNTS: Record<PetSpriteRow, number> = {
  idle: 6,
  'running-right': 8,
  'running-left': 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
};

export const PET_SPRITE_FRAME_WIDTH = 192;
export const PET_SPRITE_FRAME_HEIGHT = 208;
// Total time for one pass through a row's frames (Codex ~1.1s), so per-frame
// time is LOOP_MS / frameCount regardless of how many frames the row has.
export const PET_SPRITE_LOOP_MS = 1100;
// Codex behavior: a non-idle row plays its frames this many times, then the pet
// falls back into the idle loop. idle and the drag-override rows loop forever.
export const PET_SPRITE_LOOP_COUNT = 3;

// The semantic state surfaced by the overlay. Mirrors Codex's
// running / waiting-for-input / ready-for-review, plus failed (sprite-supported)
// and idle (resting). The interaction rows (waving on wake, jumping on hover,
// running-left/right while dragging) are driven by the renderer, not this state.
export type PetState = 'idle' | 'running' | 'waiting' | 'review' | 'failed';

export const PET_STATE_TO_ROW: Record<PetState, PetSpriteRow> = {
  idle: 'idle',
  running: 'running',
  waiting: 'waiting',
  review: 'review',
  failed: 'failed',
};

// One loaded pet, as returned by the desktop `desktop_pet_get` IPC: the
// spritesheet inlined as a data URL (see packages/electron/pets.mjs), keyed by
// slug. The overlay only needs the sheet; the pet list supplies name/description.
export interface PetAsset {
  slug: string;
  spritesheetDataUrl: string;
}

export type PetApprovalKind = 'permission' | 'question';

export interface PetApproval {
  kind: PetApprovalKind;
  /** Request id (permission/question id). */
  id: string;
  sessionId: string;
  sessionTitle: string;
  /** Short human label, e.g. "edit: src/foo.ts" or the question header. */
  label: string;
}

// The single thread the bubble surfaces. For `running` this is the
// most-recently-interacted running session; for review/failed/waiting it is the
// session tied to the dominant state.
export interface PetThread {
  sessionId: string;
  title: string;
  /**
   * A truncated snapshot of the latest assistant text (NOT streamed token by
   * token). Empty string when there is nothing to show yet.
   */
  caption: string;
}

export interface PetStateMessage {
  type: 'pet-state';
  state: PetState;
  thread: PetThread | null;
  /** Pending approvals to surface (Allow/Deny). Usually 0 or 1 surfaced. */
  approvals: PetApproval[];
  /**
   * Honest count for the dominant `state`, shown on the minimized badge:
   * failed → errored sessions, waiting → pending approvals, review → unseen
   * finished sessions, running → running sessions, idle → 0. Not a fabricated
   * value — 0 only when there is genuinely nothing to count (idle).
   */
  count: number;
}

export type PetActionMessage =
  | {
      type: 'respond-permission';
      sessionId: string;
      id: string;
      response: 'once' | 'always' | 'reject';
    }
  | { type: 'focus-session'; sessionId: string }
  // Pet asks the main renderer to (re)broadcast the current state — sent on
  // pet-window mount so it doesn't wait for the next throttled tick.
  | { type: 'request-state' };

// Pure inputs for the dominant-state resolver. Kept primitive so it is trivial
// to unit test and cheap to evaluate on the (throttled) broadcast path.
export interface PetSignals {
  /** Any session currently surfaced as errored (notification store hasError). */
  hasFailed: boolean;
  /** Pending permission/question approvals. */
  approvalCount: number;
  /** Any finished-but-unseen session (idle + unread) → "ready for review". */
  hasReview: boolean;
  /** Sessions currently busy/retry. */
  runningCount: number;
}

/**
 * Resolve the dominant pet state. Priority, highest-attention first:
 *   failed > waiting > review > running > idle
 * Higher-attention states intentionally win over plain "running".
 */
export function resolvePetState(signals: PetSignals): PetState {
  if (signals.hasFailed) return 'failed';
  if (signals.approvalCount > 0) return 'waiting';
  if (signals.hasReview) return 'review';
  if (signals.runningCount > 0) return 'running';
  return 'idle';
}
