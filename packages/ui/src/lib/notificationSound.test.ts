import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_SOUND_BY_CHANNEL,
  SOUND_IDS,
  claimNotificationSound,
  isSoundId,
  isSurfaceFocused,
  playNotificationSound,
  previewSoundById,
  resetNotificationSoundCaches,
  resolveNotificationSound,
  resolveSoundChannelForKind,
  soundSrc,
  type SoundSettings,
} from "./notificationSound";

const enabledSettings = (overrides: Partial<SoundSettings> = {}): SoundSettings => ({
  notificationSoundsEnabled: true,
  notificationSoundWhen: "hidden-only",
  notificationSoundCompletion: DEFAULT_SOUND_BY_CHANNEL.completion,
  notificationSoundQuestion: DEFAULT_SOUND_BY_CHANNEL.question,
  notificationSoundPermission: DEFAULT_SOUND_BY_CHANNEL.permission,
  notificationSoundError: DEFAULT_SOUND_BY_CHANNEL.error,
  ...overrides,
});

/** A window that is not focused, so `hidden-only` allows the cue through. */
const backgrounded = { focused: false, claimed: false, audioAvailable: true };

afterEach(() => {
  resetNotificationSoundCaches();
});

describe("sound pack", () => {
  test("covers exactly the vendored clip count", () => {
    expect(SOUND_IDS).toHaveLength(45);
  });

  test("every default resolves to a real id", () => {
    for (const id of Object.values(DEFAULT_SOUND_BY_CHANNEL)) {
      expect(isSoundId(id)).toBe(true);
    }
  });

  test("rejects an id that is not bundled", () => {
    expect(isSoundId("yup-99")).toBe(false);
    expect(isSoundId("")).toBe(false);
    expect(isSoundId(undefined)).toBe(false);
  });
});

describe("kind to channel", () => {
  test("maps every kind the server emits", () => {
    expect(resolveSoundChannelForKind("ready")).toBe("completion");
    expect(resolveSoundChannelForKind("goal")).toBe("completion");
    expect(resolveSoundChannelForKind("plugin")).toBe("completion");
    expect(resolveSoundChannelForKind("opencode-restart-interrupted")).toBe("completion");
    expect(resolveSoundChannelForKind("question")).toBe("question");
    expect(resolveSoundChannelForKind("permission")).toBe("permission");
    expect(resolveSoundChannelForKind("error")).toBe("error");
  });

  test("a kind with no cue stays silent rather than guessing", () => {
    expect(resolveSoundChannelForKind("something-new")).toBeUndefined();
    expect(resolveSoundChannelForKind(undefined)).toBeUndefined();
  });
});

describe("the gate", () => {
  test("plays the configured cue for a known kind", () => {
    expect(resolveNotificationSound({ kind: "error" }, enabledSettings(), backgrounded)).toEqual({
      play: true,
      soundId: DEFAULT_SOUND_BY_CHANNEL.error,
      channel: "error",
    });
  });

  test("sounds off silences everything", () => {
    const resolution = resolveNotificationSound(
      { kind: "error" },
      enabledSettings({ notificationSoundsEnabled: false }),
      backgrounded,
    );
    expect(resolution).toEqual({ play: false, reason: "disabled" });
  });

  test("hidden-only skips a focused window but 'always' does not", () => {
    const focused = { ...backgrounded, focused: true };
    expect(resolveNotificationSound({ kind: "error" }, enabledSettings(), focused)).toEqual({
      play: false,
      reason: "focused",
    });
    expect(
      resolveNotificationSound(
        { kind: "error" },
        enabledSettings({ notificationSoundWhen: "always" }),
        focused,
      ),
    ).toMatchObject({ play: true });
  });

  test("a claimed notification is left to the window that already cued it", () => {
    expect(
      resolveNotificationSound({ kind: "error" }, enabledSettings(), { ...backgrounded, claimed: true }),
    ).toEqual({ play: false, reason: "claimed" });
  });

  test("no Audio means no cue, not a throw", () => {
    expect(
      resolveNotificationSound({ kind: "error" }, enabledSettings(), { ...backgrounded, audioAvailable: false }),
    ).toEqual({ play: false, reason: "no-audio" });
  });

  test("an unknown kind is checked before the claim so it stays cheap", () => {
    expect(resolveNotificationSound({ kind: "mystery" }, enabledSettings(), backgrounded)).toEqual({
      play: false,
      reason: "no-channel",
    });
  });

  test("a stored id that no longer resolves falls back to the default", () => {
    const resolution = resolveNotificationSound(
      { kind: "error" },
      enabledSettings({ notificationSoundError: "yup-99" }),
      backgrounded,
    );
    expect(resolution).toEqual({
      play: true,
      soundId: DEFAULT_SOUND_BY_CHANNEL.error,
      channel: "error",
    });
  });
});

describe("the claim", () => {
  const payload = { kind: "error", tag: "error-ses_1" };

  test("the first window cues, the second is silent", () => {
    // The gate is asked with `claimed: false` both times; the claim itself lives
    // behind `playNotificationSound`, so the pair proves the dedupe end to end.
    const first = resolveNotificationSound(payload, enabledSettings(), backgrounded);
    const second = resolveNotificationSound(payload, enabledSettings(), backgrounded);
    expect(first).toMatchObject({ play: true });
    expect(second).toMatchObject({ play: true });

    // Replaying the same notification must not queue a second element.
    playNotificationSound(payload, enabledSettings({ notificationSoundWhen: "always" }));
    playNotificationSound(payload, enabledSettings({ notificationSoundWhen: "always" }));
  });

  test("a different notification is not swallowed by an existing claim", () => {
    playNotificationSound(payload, enabledSettings({ notificationSoundWhen: "always" }));
    playNotificationSound(
      { kind: "error", tag: "error-ses_2" },
      enabledSettings({ notificationSoundWhen: "always" }),
    );
  });

  test("a claim already in storage blocks the second window", () => {
    // The desktop main window and every mini-chat mount `SyncProvider` and all
    // receive the same frame, so the claim has to hold through storage, not
    // just this window's memory. Only the in-memory table is reset between the
    // two calls here, which is exactly the second window's situation.
    const backing = new Map<string, string>();
    const previous = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => backing.get(key) ?? null,
          setItem: (key: string, value: string) => void backing.set(key, value),
          removeItem: (key: string) => void backing.delete(key),
        },
      },
    });
    try {
      expect(claimNotificationSound({ kind: "error", tag: "shared" })).toBe(true);
      expect(backing.has("openchamber-sound-claim:shared")).toBe(true);

      // A second window: fresh memory, same storage.
      resetNotificationSoundCaches();
      expect(claimNotificationSound({ kind: "error", tag: "shared" })).toBe(false);

      // A different notification in that second window still gets its cue.
      expect(claimNotificationSound({ kind: "error", tag: "other" })).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
    }
  });
});

describe("playback degrades quietly", () => {
  test("soundSrc resolves nothing outside a real bundle", async () => {
    // `import.meta.glob` is a Vite transform, so under the test runner there is
    // no asset table. This is the guard that keeps the module importable.
    expect(await soundSrc(DEFAULT_SOUND_BY_CHANNEL.error)).toBeUndefined();
  });

  test("an unknown id resolves nothing rather than throwing", async () => {
    expect(await soundSrc("nope-99")).toBeUndefined();
    expect(await soundSrc(undefined)).toBeUndefined();
  });

  test("preview reports failure instead of throwing", async () => {
    expect(await previewSoundById(DEFAULT_SOUND_BY_CHANNEL.error)).toBe(false);
  });

  test("playNotificationSound is a no-op rather than a throw", () => {
    try {
      playNotificationSound({ kind: "error", tag: "t" }, enabledSettings({ notificationSoundWhen: "always" }));
    } catch (error) {
      throw new Error(`playNotificationSound raised: ${String(error)}`);
    }
  });
});

describe("focus probe", () => {
  test("a document that is not visible is not focused", () => {
    expect(isSurfaceFocused()).toBe(false);
  });
});
