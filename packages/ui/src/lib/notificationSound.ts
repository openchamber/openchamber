/**
 * Notification sound playback.
 *
 * Ports opencode's attention sound system (see `packages/app/src/utils/sound.ts`
 * and `packages/tui/src/attention.ts` in sst/opencode) to OpenChamber's shared
 * UI package. Sounds are MIT-licensed assets sourced from opencode.
 *
 * Design notes:
 * - Uses static ESM imports instead of `import.meta.glob` because `packages/ui`
 *   type-checks with bare `tsc --noEmit` (no `vite/client` types). Vite still
 *   resolves these imports to hashed asset URLs at build time.
 * - Reuses the existing `notifyOnCompletion` / `notifyOnError` / `notifyOnQuestion`
 *   / `notifyOnSubtasks` toggles for per-event gating instead of duplicating
 *   them as sound-specific toggles.
 * - Reuses the existing `notificationMode` ('always' | 'hidden-only') for focus
 *   gating; callers pass the current view state to `playSoundForEvent`.
 */

import bipBop01 from '../assets/audio/bip-bop-01.aac';
import bipBop02 from '../assets/audio/bip-bop-02.aac';
import bipBop03 from '../assets/audio/bip-bop-03.aac';
import bipBop04 from '../assets/audio/bip-bop-04.aac';
import bipBop05 from '../assets/audio/bip-bop-05.aac';
import bipBop06 from '../assets/audio/bip-bop-06.aac';
import bipBop07 from '../assets/audio/bip-bop-07.aac';
import bipBop08 from '../assets/audio/bip-bop-08.aac';
import bipBop09 from '../assets/audio/bip-bop-09.aac';
import bipBop10 from '../assets/audio/bip-bop-10.aac';
import alert01 from '../assets/audio/alert-01.aac';
import alert02 from '../assets/audio/alert-02.aac';
import alert03 from '../assets/audio/alert-03.aac';
import alert04 from '../assets/audio/alert-04.aac';
import alert05 from '../assets/audio/alert-05.aac';
import alert06 from '../assets/audio/alert-06.aac';
import alert07 from '../assets/audio/alert-07.aac';
import alert08 from '../assets/audio/alert-08.aac';
import alert09 from '../assets/audio/alert-09.aac';
import alert10 from '../assets/audio/alert-10.aac';

export type NotificationEventKind = 'completion' | 'error' | 'question' | 'subtask';
export type NotificationSoundPack = 'bip-bop' | 'alert';

/**
 * Per-pack sound asset registries, keyed by 1-based index.
 * Index 1 = `-01`, index 2 = `-02`, etc.
 */
const PACK_SOUNDS: Record<NotificationSoundPack, string[]> = {
  'bip-bop': [
    bipBop01, bipBop02, bipBop03, bipBop04, bipBop05,
    bipBop06, bipBop07, bipBop08, bipBop09, bipBop10,
  ],
  alert: [
    alert01, alert02, alert03, alert04, alert05,
    alert06, alert07, alert08, alert09, alert10,
  ],
};

/**
 * Default event -> sound index mapping within a pack.
 * Mirrors opencode's `attention.ts` DEFAULT_PACK semantics, adapted to the
 * starter asset set (bip-bop + alert only; opencode's nope/yup packs are not
 * included in the starter set).
 *
 * - completion: bip-bop-01 / alert-01  (opencode: bip-bop-01)
 * - subtask:    bip-bop-02 / alert-02  (opencode: yup-01, remapped)
 * - error:      alert-01 / alert-01    (opencode: nope-03, remapped to alert)
 * - question:   bip-bop-03 / alert-03  (opencode: bip-bop-03)
 */
const DEFAULT_EVENT_SOUND_INDEX: Record<NotificationEventKind, number> = {
  completion: 1,
  subtask: 2,
  error: 1,
  question: 3,
};

/** Clamp volume to [0, 1]; non-finite values become 0. */
function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  return Math.min(1, Math.max(0, volume));
}

/** Resolve the asset URL for an event within a pack. */
function resolveEventSound(
  event: NotificationEventKind,
  pack: NotificationSoundPack,
): string | undefined {
  const sounds = PACK_SOUNDS[pack];
  if (!sounds) return undefined;
  const index = DEFAULT_EVENT_SOUND_INDEX[event] ?? 1;
  return sounds[index - 1];
}

/**
 * Play a sound from a resolved asset URL at the given volume.
 * Creates a fresh `Audio` element each call so overlapping sounds don't cut
 * each other off (mirrors opencode's `playSound`).
 */
function playSound(src: string, volume: number): void {
  try {
    const audio = new Audio(src);
    audio.volume = clampVolume(volume);
    void audio.play().catch(() => {
      // Autoplay can be blocked by the browser before user interaction;
      // the sound will simply not play. This is expected and non-fatal.
    });
  } catch {
    // `Audio` may be unavailable in some non-browser contexts; ignore.
  }
}

/**
 * Preview a sound pack at a given volume (for the settings UI test button).
 * Plays the first sound of the pack.
 */
export function previewSoundPack(pack: NotificationSoundPack, volume: number): void {
  const sounds = PACK_SOUNDS[pack];
  if (!sounds || sounds.length === 0) return;
  playSound(sounds[0], volume);
}

// ---------------------------------------------------------------------------
// High-level gating + playback (used by sync integration)
// ---------------------------------------------------------------------------

/**
 * Settings required to decide whether a sound should play.
 * Field names mirror `useUIStore` so `useUIStore.getState()` can be passed
 * directly via structural typing.
 */
export interface NotificationSoundSettings {
  notificationSoundEnabled: boolean;
  notificationSoundVolume: number;
  notificationSoundPack: NotificationSoundPack;
  notificationMode: 'always' | 'hidden-only';
  notifyOnCompletion: boolean;
  notifyOnError: boolean;
  notifyOnQuestion: boolean;
  notifyOnSubtasks: boolean;
}

const EVENT_TOGGLE_ENABLED: Record<NotificationEventKind, (s: NotificationSoundSettings) => boolean> = {
  completion: (s) => s.notifyOnCompletion,
  error: (s) => s.notifyOnError,
  question: (s) => s.notifyOnQuestion,
  subtask: (s) => s.notifyOnSubtasks,
};

/**
 * Decide whether a sound should play for an event.
 *
 * Gating order:
 * 1. Master toggle (`notificationSoundEnabled`)
 * 2. Per-event toggle (`notifyOnCompletion` / `notifyOnError` / etc.)
 * 3. Focus gating via `notificationMode`:
 *    - `'always'`   -> always play
 *    - `'hidden-only'` -> skip when the user is already viewing the session
 */
function shouldPlaySoundForEvent(
  event: NotificationEventKind,
  settings: NotificationSoundSettings,
  isViewed: boolean,
): boolean {
  if (!settings.notificationSoundEnabled) return false;
  if (!EVENT_TOGGLE_ENABLED[event](settings)) return false;
  if (settings.notificationMode === 'hidden-only' && isViewed) return false;
  return true;
}

/**
 * Play the notification sound for an event, applying all gating.
 *
 * Callers pass the UI store state (or any object satisfying
 * `NotificationSoundSettings`) and whether the originating session is
 * currently being viewed.
 */
export function playSoundForEvent(
  event: NotificationEventKind,
  settings: NotificationSoundSettings,
  isViewed: boolean,
): void {
  if (!shouldPlaySoundForEvent(event, settings, isViewed)) return;
  const src = resolveEventSound(event, settings.notificationSoundPack);
  if (!src) return;
  playSound(src, settings.notificationSoundVolume);
}
