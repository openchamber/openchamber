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
 * - Each event maps to a specific sound id (e.g. "bip-bop-01"), matching
 *   opencode's per-event sound selection model. Users can override each
 *   event's sound independently in the settings UI.
 * - Reuses the existing `notifyOnCompletion` / `notifyOnError` / `notifyOnQuestion`
 *   / `notifyOnSubtasks` toggles for per-event gating, plus a new
 *   `notifyOnPermission` toggle, instead of duplicating them as
 *   sound-specific toggles.
 * - Focus gating: all events default to always playing regardless of view state
 *   (matching opencode's `sound.when: "always"` default). A global
 *   `notificationSoundFocusOnly` toggle (default off) overrides this so every
 *   event plays only when not viewed. This is independent of the native
 *   notification `notificationMode`, which only governs OS notifications.
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
import nope01 from '../assets/audio/nope-01.aac';
import nope02 from '../assets/audio/nope-02.aac';
import nope03 from '../assets/audio/nope-03.aac';
import nope04 from '../assets/audio/nope-04.aac';
import nope05 from '../assets/audio/nope-05.aac';
import nope06 from '../assets/audio/nope-06.aac';
import nope07 from '../assets/audio/nope-07.aac';
import nope08 from '../assets/audio/nope-08.aac';
import nope09 from '../assets/audio/nope-09.aac';
import nope10 from '../assets/audio/nope-10.aac';
import staplebops01 from '../assets/audio/staplebops-01.aac';
import staplebops02 from '../assets/audio/staplebops-02.aac';
import staplebops03 from '../assets/audio/staplebops-03.aac';
import staplebops04 from '../assets/audio/staplebops-04.aac';
import staplebops05 from '../assets/audio/staplebops-05.aac';
import staplebops06 from '../assets/audio/staplebops-06.aac';
import staplebops07 from '../assets/audio/staplebops-07.aac';
import yup01 from '../assets/audio/yup-01.aac';
import yup02 from '../assets/audio/yup-02.aac';
import yup03 from '../assets/audio/yup-03.aac';
import yup04 from '../assets/audio/yup-04.aac';
import yup05 from '../assets/audio/yup-05.aac';
import yup06 from '../assets/audio/yup-06.aac';

export type NotificationEventKind = 'completion' | 'error' | 'question' | 'permission' | 'subtask';
type NotificationSoundPack = 'bip-bop' | 'alert' | 'nope' | 'staplebops' | 'yup';
export type NotificationSoundEventSounds = Record<NotificationEventKind, string>;

interface SoundEntry {
  /** Sound id, e.g. "bip-bop-01". */
  id: string;
  pack: NotificationSoundPack;
  /** 1-based index within the pack. */
  index: number;
  url: string;
}

/** All available sounds across all packs. */
const SOUNDS: SoundEntry[] = [
  { id: 'bip-bop-01', pack: 'bip-bop', index: 1, url: bipBop01 },
  { id: 'bip-bop-02', pack: 'bip-bop', index: 2, url: bipBop02 },
  { id: 'bip-bop-03', pack: 'bip-bop', index: 3, url: bipBop03 },
  { id: 'bip-bop-04', pack: 'bip-bop', index: 4, url: bipBop04 },
  { id: 'bip-bop-05', pack: 'bip-bop', index: 5, url: bipBop05 },
  { id: 'bip-bop-06', pack: 'bip-bop', index: 6, url: bipBop06 },
  { id: 'bip-bop-07', pack: 'bip-bop', index: 7, url: bipBop07 },
  { id: 'bip-bop-08', pack: 'bip-bop', index: 8, url: bipBop08 },
  { id: 'bip-bop-09', pack: 'bip-bop', index: 9, url: bipBop09 },
  { id: 'bip-bop-10', pack: 'bip-bop', index: 10, url: bipBop10 },
  { id: 'alert-01', pack: 'alert', index: 1, url: alert01 },
  { id: 'alert-02', pack: 'alert', index: 2, url: alert02 },
  { id: 'alert-03', pack: 'alert', index: 3, url: alert03 },
  { id: 'alert-04', pack: 'alert', index: 4, url: alert04 },
  { id: 'alert-05', pack: 'alert', index: 5, url: alert05 },
  { id: 'alert-06', pack: 'alert', index: 6, url: alert06 },
  { id: 'alert-07', pack: 'alert', index: 7, url: alert07 },
  { id: 'alert-08', pack: 'alert', index: 8, url: alert08 },
  { id: 'alert-09', pack: 'alert', index: 9, url: alert09 },
  { id: 'alert-10', pack: 'alert', index: 10, url: alert10 },
  { id: 'nope-01', pack: 'nope', index: 1, url: nope01 },
  { id: 'nope-02', pack: 'nope', index: 2, url: nope02 },
  { id: 'nope-03', pack: 'nope', index: 3, url: nope03 },
  { id: 'nope-04', pack: 'nope', index: 4, url: nope04 },
  { id: 'nope-05', pack: 'nope', index: 5, url: nope05 },
  { id: 'nope-06', pack: 'nope', index: 6, url: nope06 },
  { id: 'nope-07', pack: 'nope', index: 7, url: nope07 },
  { id: 'nope-08', pack: 'nope', index: 8, url: nope08 },
  { id: 'nope-09', pack: 'nope', index: 9, url: nope09 },
  { id: 'nope-10', pack: 'nope', index: 10, url: nope10 },
  { id: 'staplebops-01', pack: 'staplebops', index: 1, url: staplebops01 },
  { id: 'staplebops-02', pack: 'staplebops', index: 2, url: staplebops02 },
  { id: 'staplebops-03', pack: 'staplebops', index: 3, url: staplebops03 },
  { id: 'staplebops-04', pack: 'staplebops', index: 4, url: staplebops04 },
  { id: 'staplebops-05', pack: 'staplebops', index: 5, url: staplebops05 },
  { id: 'staplebops-06', pack: 'staplebops', index: 6, url: staplebops06 },
  { id: 'staplebops-07', pack: 'staplebops', index: 7, url: staplebops07 },
  { id: 'yup-01', pack: 'yup', index: 1, url: yup01 },
  { id: 'yup-02', pack: 'yup', index: 2, url: yup02 },
  { id: 'yup-03', pack: 'yup', index: 3, url: yup03 },
  { id: 'yup-04', pack: 'yup', index: 4, url: yup04 },
  { id: 'yup-05', pack: 'yup', index: 5, url: yup05 },
  { id: 'yup-06', pack: 'yup', index: 6, url: yup06 },
];

/** Lookup table: sound id -> entry. */
const SOUND_BY_ID = new Map<string, SoundEntry>(SOUNDS.map((s) => [s.id, s]));

/**
 * Sound options grouped by pack, for the settings UI dropdowns.
 * Each option's `id` is the sound id (e.g. "bip-bop-01"); `label` is a
 * human-readable label (e.g. "Bip Bop 1").
 */
export const SOUND_PACK_GROUPS: { pack: NotificationSoundPack; label: string; sounds: { id: string; label: string }[] }[] = [
  {
    pack: 'bip-bop',
    label: 'Bip Bop',
    sounds: SOUNDS.filter((s) => s.pack === 'bip-bop').map((s) => ({ id: s.id, label: `Bip Bop ${s.index}` })),
  },
  {
    pack: 'alert',
    label: 'Alert',
    sounds: SOUNDS.filter((s) => s.pack === 'alert').map((s) => ({ id: s.id, label: `Alert ${s.index}` })),
  },
  {
    pack: 'nope',
    label: 'Nope',
    sounds: SOUNDS.filter((s) => s.pack === 'nope').map((s) => ({ id: s.id, label: `Nope ${s.index}` })),
  },
  {
    pack: 'staplebops',
    label: 'Staplebops',
    sounds: SOUNDS.filter((s) => s.pack === 'staplebops').map((s) => ({ id: s.id, label: `Staplebops ${s.index}` })),
  },
  {
    pack: 'yup',
    label: 'Yup',
    sounds: SOUNDS.filter((s) => s.pack === 'yup').map((s) => ({ id: s.id, label: `Yup ${s.index}` })),
  },
];

/**
 * Default event -> sound id mapping.
 * Mirrors opencode's `attention.ts` DEFAULT_PACK semantics:
 * - completion: bip-bop-01  (opencode: bip-bop-01 for "done"/"default")
 * - error:      nope-03      (opencode: nope-03)
 * - question:   bip-bop-03   (opencode: bip-bop-03)
 * - permission: staplebops-06 (opencode: staplebops-06)
 * - subtask:    yup-01       (opencode: yup-01 for "subagent_done")
 */
export const DEFAULT_EVENT_SOUNDS: NotificationSoundEventSounds = {
  completion: 'bip-bop-01',
  error: 'nope-03',
  question: 'bip-bop-03',
  permission: 'staplebops-06',
  subtask: 'yup-01',
};


/** Clamp volume to [0, 1]; non-finite values become 0. */
function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  return Math.min(1, Math.max(0, volume));
}

/** Resolve the asset URL for a sound id, or undefined if the id is unknown. */
function resolveSoundUrl(soundId: string): string | undefined {
  const entry = SOUND_BY_ID.get(soundId);
  return entry?.url;
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
 * Preview a specific sound at a given volume (for the settings UI).
 */
export function previewSound(soundId: string, volume: number): void {
  const url = resolveSoundUrl(soundId);
  if (!url) return;
  playSound(url, volume);
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
  notificationSoundEventSounds: NotificationSoundEventSounds;
  /** When true, all sounds play only when the session is not being viewed. */
  notificationSoundFocusOnly: boolean;
  notifyOnCompletion: boolean;
  notifyOnError: boolean;
  notifyOnQuestion: boolean;
  notifyOnPermission: boolean;
  notifyOnSubtasks: boolean;
}

const EVENT_TOGGLE_ENABLED: Record<NotificationEventKind, (s: NotificationSoundSettings) => boolean> = {
  completion: (s) => s.notifyOnCompletion,
  error: (s) => s.notifyOnError,
  question: (s) => s.notifyOnQuestion,
  permission: (s) => s.notifyOnPermission,
  subtask: (s) => s.notifyOnSubtasks,
};

/**
 * Per-event focus policy mirroring opencode's `packages/tui/src/attention.ts`.
 * All events default to `'always'` (play regardless of view state), matching
 * opencode's `sound.when: "always"` default for every built-in event.
 * The `notificationSoundFocusOnly` toggle overrides this so every event only
 * plays when the session is not being viewed.
 */
const EVENT_FOCUS_POLICY: Record<NotificationEventKind, 'always' | 'blurred'> = {
  completion: 'always',
  error: 'always',
  question: 'always',
  permission: 'always',
  subtask: 'always',
};

/**
 * Decide whether a sound should play for an event.
 *
 * Gating order:
 * 1. Master toggle (`notificationSoundEnabled`)
 * 2. Per-event toggle (`notifyOnCompletion` / `notifyOnError` / etc.)
 * 3. Focus gating:
 *    - `notificationSoundFocusOnly` (default off): when enabled, every event
 *      plays only when the session is not being viewed.
 *    - Otherwise, all events play regardless of view state (matching opencode's
 *      `sound.when: "always"` default).
 *
 * Exported for unit testing the gating logic.
 */
export function shouldPlaySoundForEvent(
  event: NotificationEventKind,
  settings: NotificationSoundSettings,
  isViewed: boolean,
): boolean {
  if (!settings.notificationSoundEnabled) return false;
  if (!EVENT_TOGGLE_ENABLED[event](settings)) return false;
  if (settings.notificationSoundFocusOnly) {
    if (isViewed) return false;
  } else if (EVENT_FOCUS_POLICY[event] === 'blurred' && isViewed) {
    return false;
  }
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
  const configuredId = settings.notificationSoundEventSounds[event] ?? DEFAULT_EVENT_SOUNDS[event];
  let src = resolveSoundUrl(configuredId);
  if (!src) {
    // The configured sound id is unknown (e.g. a pack was removed in a newer
    // version). Fall back to the default sound for this event so the user
    // still hears a cue rather than silence.
    src = resolveSoundUrl(DEFAULT_EVENT_SOUNDS[event]);
    if (!src) return;
  }
  playSound(src, settings.notificationSoundVolume);
}
