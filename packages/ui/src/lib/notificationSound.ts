/**
 * Notification sounds: a short audio cue for each event that already raises a
 * notification, so a finished turn, an error, or a pending question is audible
 * without watching the window.
 *
 * The 45 clips are vendored from upstream opencode's attention pack
 * (`sst/opencode`, `packages/ui/src/assets/audio`, MIT) and loaded lazily
 * through `import.meta.glob`, the same shape opencode uses in
 * `packages/app/src/utils/sound.ts`.
 *
 * Why this lives beside `RuntimeAPIs.notifications` instead of inside it: a cue
 * plays the same way on every surface, so it is not a capability a surface can
 * deny. The native mobile shell swaps the whole notifications API for a no-op
 * (`apps/renderMobileApp.tsx`), which leaves this mapping running harmlessly
 * with nothing to notify.
 *
 * Playback is a no-op wherever it cannot work: no `Audio` constructor, an
 * unknown sound id, a focus gate that says "you are already looking", or a
 * `localStorage` that throws.
 */

import type { NotificationPayload } from "@/lib/api/types";

/** Clip counts per pack, matching the vendored assets exactly. */
const SOUND_PACK_SIZES = [
  ["yup", 6],
  ["nope", 12],
  ["staplebops", 7],
  ["bip-bop", 10],
  ["alert", 10],
] as const;

export type SoundPack = (typeof SOUND_PACK_SIZES)[number][0];

/** Pack names in listing order, for grouping a picker. */
export const SOUND_PACKS: SoundPack[] = SOUND_PACK_SIZES.map(([pack]) => pack);

/** The ids belonging to one pack, in listing order. */
export const soundIdsForPack = (pack: SoundPack): string[] => {
  const count = SOUND_PACK_SIZES.find(([candidate]) => candidate === pack)?.[1] ?? 0;
  return Array.from({ length: count }, (_, index) => `${pack}-${String(index + 1).padStart(2, "0")}`);
};

const SOUND_ID_LIST: string[] = SOUND_PACK_SIZES.flatMap(([pack, count]) =>
  Array.from({ length: count }, (_, index) => `${pack}-${String(index + 1).padStart(2, "0")}`),
);

export const SOUND_IDS: readonly string[] = SOUND_ID_LIST;

/** Any `<pack>-<nn>` id; `isSoundId` is what proves one is actually bundled. */
export type SoundId = `${SoundPack}-${string}`;

/** The events that get their own cue. */
export const SOUND_CHANNELS = [
  "completion",
  "question",
  "permission",
  "error",
] as const;

export type SoundChannel = (typeof SOUND_CHANNELS)[number];

/**
 * Notification `kind` to cue. `goal`, `plugin`, and
 * `opencode-restart-interrupted` ride the completion cue: they all mean "your
 * agent wants you back". A subtask is deliberately absent — the server folds it
 * into `ready` before fan-out (`lib/notifications/runtime.js`), so the client
 * cannot tell the two apart.
 */
const SOUND_CHANNEL_BY_KIND = {
  ready: "completion",
  goal: "completion",
  plugin: "completion",
  "opencode-restart-interrupted": "completion",
  question: "question",
  permission: "permission",
  error: "error",
} as const satisfies Record<string, SoundChannel>;

export const DEFAULT_SOUND_BY_CHANNEL = {
  completion: "yup-01",
  question: "bip-bop-01",
  permission: "alert-01",
  error: "nope-01",
} as const satisfies Record<SoundChannel, SoundId>;

const SOUND_CLAIM_TTL_MS = 5000;
const SOUND_CLAIM_STORAGE_PREFIX = "openchamber-sound-claim:";

const SOUND_SETTING_BY_CHANNEL = {
  completion: "notificationSoundCompletion",
  question: "notificationSoundQuestion",
  permission: "notificationSoundPermission",
  error: "notificationSoundError",
} as const satisfies Record<SoundChannel, keyof SoundSettings>;

export type SoundSettings = {
  notificationSoundsEnabled: boolean;
  notificationSoundWhen: "always" | "hidden-only";
  notificationSoundCompletion: string;
  notificationSoundQuestion: string;
  notificationSoundPermission: string;
  notificationSoundError: string;
};

/** The cue for a notification kind, or `undefined` when the kind gets no cue. */
export const resolveSoundChannelForKind = (kind: string | undefined): SoundChannel | undefined => {
  if (!kind) return undefined;
  // SAFETY: `kind` is an open string from the wire. Indexing the literal returns
  // `undefined` for an unknown key, which is exactly the "no cue" result.
  return SOUND_CHANNEL_BY_KIND[kind as keyof typeof SOUND_CHANNEL_BY_KIND];
};

export const isSoundId = (id: string | undefined): id is SoundId =>
  id !== undefined && SOUND_IDS.includes(id);

/** Whether the window the user is looking at is the one that would make a cue redundant. */
export const isSurfaceFocused = (): boolean => {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
};

const soundIdForChannel = (settings: SoundSettings, channel: SoundChannel): SoundId => {
  const configured = settings[SOUND_SETTING_BY_CHANNEL[channel]];
  // A stored id that no longer resolves (a pack was renamed, a document was
  // hand-edited) falls back to the default rather than going silent.
  return isSoundId(configured) ? configured : DEFAULT_SOUND_BY_CHANNEL[channel];
};

export type SoundResolution =
  | { play: false; reason: "disabled" | "focused" | "no-channel" | "claimed" | "no-audio" }
  | { play: true; soundId: SoundId; channel: SoundChannel };

/**
 * Decides whether a notification should sound, without touching the DOM.
 * Split from playback so the whole gate is unit-testable.
 */
export const resolveNotificationSound = (
  payload: NotificationPayload | undefined,
  settings: SoundSettings,
  options: { focused: boolean; claimed: boolean; audioAvailable: boolean },
): SoundResolution => {
  if (!settings.notificationSoundsEnabled) return { play: false, reason: "disabled" };
  if (settings.notificationSoundWhen === "hidden-only" && options.focused) {
    return { play: false, reason: "focused" };
  }
  const channel = resolveSoundChannelForKind(payload?.kind);
  if (!channel) return { play: false, reason: "no-channel" };
  if (options.claimed) return { play: false, reason: "claimed" };
  if (!options.audioAvailable) return { play: false, reason: "no-audio" };
  return { play: true, soundId: soundIdForChannel(settings, channel), channel };
};

const soundClaims = new Map<string, number>();

const getSoundClaimKey = (payload: NotificationPayload | undefined): string => {
  const tag = typeof payload?.tag === "string" ? payload.tag.trim() : "";
  if (tag) return tag;
  return [payload?.sessionId, payload?.kind, payload?.title, payload?.body]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .join("|");
};

/**
 * Claims this notification for one cue. Several windows receive the same
 * `openchamber:notification` frame (the desktop main window and every mini-chat
 * each mount `SyncProvider`), so without a claim one event sounds N times. The
 * `localStorage` half is what makes it hold across windows; the in-memory half
 * covers a browser where storage is unavailable.
 *
 * Exported because the cross-window half is the part worth pinning down: it is
 * the only dedupe between two renderers of the same app.
 */
export const claimNotificationSound = (payload: NotificationPayload | undefined): boolean => {
  const key = getSoundClaimKey(payload);
  if (!key) return true;

  const now = Date.now();
  for (const [claimed, claimedAt] of soundClaims) {
    if (now - claimedAt > SOUND_CLAIM_TTL_MS) soundClaims.delete(claimed);
  }

  const claimedAt = soundClaims.get(key) ?? 0;
  if (now - claimedAt < SOUND_CLAIM_TTL_MS) return false;

  try {
    const storage = typeof window === "undefined" ? null : window.localStorage;
    if (storage) {
      const storageKey = `${SOUND_CLAIM_STORAGE_PREFIX}${key}`;
      const stored = Number(storage.getItem(storageKey) ?? "0");
      if (Number.isFinite(stored) && now - stored < SOUND_CLAIM_TTL_MS) {
        soundClaims.set(key, stored);
        return false;
      }
      if (Number.isFinite(stored) && stored > 0) {
        storage.removeItem(storageKey);
      }
      storage.setItem(storageKey, String(now));
    }
  } catch {
    // Storage is best-effort; the in-memory claim still covers this window.
  }

  soundClaims.set(key, now);
  return true;
};

type SoundAssetLoaders = Record<SoundId, () => Promise<string>>;

let assetLoaders: SoundAssetLoaders | undefined;

/**
 * `import.meta.glob` is a Vite transform, so it only exists in a real bundle.
 * Under the Bun test runner it is `undefined` and the lookup is skipped, which
 * is what keeps this module importable from a unit test.
 */
const loadAssetLoaders = (): SoundAssetLoaders | undefined => {
  if (assetLoaders) return assetLoaders;
  if (typeof import.meta.glob !== "function") return undefined;

  // SAFETY: Vite types `import.meta.glob` as a module map keyed by path; each
  // value is the default export, which for a media file is its URL string.
  const files = import.meta.glob("../assets/audio/*.aac", { import: "default" }) as Record<
    string,
    () => Promise<string>
  >;
  const entries: [SoundId, () => Promise<string>][] = [];
  for (const [path, load] of Object.entries(files)) {
    const file = path.split("/").at(-1);
    // SAFETY: the glob is scoped to this directory and matches `*.aac`, so
    // dropping the extension yields an id the same list is keyed by.
    const id = file?.replace(/\.aac$/, "");
    // A file the id list does not know is skipped rather than aliased onto a real
    // slot, so dropping a stray clip into the directory cannot hijack a sound.
    if (isSoundId(id)) entries.push([id, load]);
  }
  // SAFETY: every entry key was narrowed to `SoundId` on the line above.
  assetLoaders = Object.fromEntries(entries) as SoundAssetLoaders;
  return assetLoaders;
};

const sourceCache = new Map<SoundId, Promise<string | undefined>>();

/** The bundled URL for a sound id, loaded once and cached. */
export const soundSrc = (id: string | undefined): Promise<string | undefined> => {
  if (!isSoundId(id)) return Promise.resolve(undefined);
  const load = loadAssetLoaders()?.[id];
  if (!load) return Promise.resolve(undefined);

  const cached = sourceCache.get(id);
  if (cached) return cached;
  const next = load().catch(() => undefined);
  sourceCache.set(id, next);
  return next;
};

type AudioFactory = new (src: string) => HTMLAudioElement;

/** The `Audio` constructor, or `null` off-DOM (tests, workers, SSR). */
const getAudioFactory = (): AudioFactory | null => {
  if (typeof Audio === "undefined") return null;
  return Audio;
};

const playSoundSource = (src: string | undefined): void => {
  const AudioCtor = getAudioFactory();
  if (!AudioCtor || !src) return;
  const audio = new AudioCtor(src);
  audio.volume = 1;
  // A blocked autoplay policy is expected in a browser tab that has not been
  // interacted with; the cue is a nicety and must never surface an error.
  void audio.play().catch(() => undefined);
};

/**
 * Plays one cue by id and reports whether the browser allowed it. The settings
 * preview is the only caller: it is a user gesture, so this is also the moment
 * a browser that was holding audio back lets go of it.
 */
export const previewSoundById = async (id: string | undefined): Promise<boolean> => {
  const AudioCtor = getAudioFactory();
  const src = await soundSrc(id);
  if (!AudioCtor || !src) return false;
  try {
    await new AudioCtor(src).play();
    return true;
  } catch {
    return false;
  }
};

/** Test seam: drops the claim and asset caches so each case starts clean. */
export const resetNotificationSoundCaches = (): void => {
  soundClaims.clear();
  sourceCache.clear();
  assetLoaders = undefined;
};

/**
 * The single entry point. Called from the one place a notification reaches the
 * UI, above the guard that skips re-raising a notification the desktop shell
 * already showed natively — the frame arrives either way, so a cue still plays
 * on a local desktop window.
 */
export const playNotificationSound = (
  payload: NotificationPayload | undefined,
  settings: SoundSettings,
): void => {
  const resolution = resolveNotificationSound(payload, settings, {
    focused: isSurfaceFocused(),
    claimed: false,
    audioAvailable: getAudioFactory() !== null,
  });
  if (!resolution.play) return;

  if (!claimNotificationSound(payload)) return;
  void soundSrc(resolution.soundId).then(playSoundSource);
};
