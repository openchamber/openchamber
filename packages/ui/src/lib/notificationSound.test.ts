import { describe, expect, test } from 'bun:test';
import {
  shouldPlaySoundForEvent,
  playSoundForEvent,
  DEFAULT_EVENT_SOUNDS,
  type NotificationSoundSettings,
  type NotificationEventKind,
} from './notificationSound';

/**
 * Build a settings object with all toggles enabled by default and sensible
 * overrides, so individual gating stages can be exercised in isolation.
 */
const buildSettings = (overrides: Partial<NotificationSoundSettings> = {}): NotificationSoundSettings => ({
  notificationSoundEnabled: true,
  notificationSoundVolume: 0.5,
  notificationSoundEventSounds: { ...DEFAULT_EVENT_SOUNDS },
  notificationSoundFocusOnly: false,
  notifyOnCompletion: true,
  notifyOnError: true,
  notifyOnQuestion: true,
  notifyOnPermission: true,
  notifyOnSubtasks: true,
  ...overrides,
});

const ALL_EVENTS: NotificationEventKind[] = ['completion', 'error', 'question', 'permission', 'subtask'];

describe('shouldPlaySoundForEvent', () => {
  describe('master toggle (stage 1)', () => {
    test('returns false for every event when the master toggle is off', () => {
      const settings = buildSettings({ notificationSoundEnabled: false });
      for (const event of ALL_EVENTS) {
        expect(shouldPlaySoundForEvent(event, settings, false)).toBe(false);
      }
    });

    test('returns true for every event (unviewed) when the master toggle is on', () => {
      const settings = buildSettings({ notificationSoundEnabled: true });
      for (const event of ALL_EVENTS) {
        expect(shouldPlaySoundForEvent(event, settings, false)).toBe(true);
      }
    });
  });

  describe('per-event toggle (stage 2)', () => {
    test('returns false when the per-event toggle is off', () => {
      expect(shouldPlaySoundForEvent('completion', buildSettings({ notifyOnCompletion: false }), false)).toBe(false);
      expect(shouldPlaySoundForEvent('error', buildSettings({ notifyOnError: false }), false)).toBe(false);
      expect(shouldPlaySoundForEvent('question', buildSettings({ notifyOnQuestion: false }), false)).toBe(false);
      expect(shouldPlaySoundForEvent('permission', buildSettings({ notifyOnPermission: false }), false)).toBe(false);
      expect(shouldPlaySoundForEvent('subtask', buildSettings({ notifyOnSubtasks: false }), false)).toBe(false);
    });

    test('master toggle off short-circuits before the per-event toggle', () => {
      // Even with the per-event toggle off, the master toggle takes precedence;
      // the result is still false either way, but this documents ordering.
      expect(
        shouldPlaySoundForEvent('completion', buildSettings({ notificationSoundEnabled: false, notifyOnCompletion: false }), false),
      ).toBe(false);
    });
  });

  describe('focus gating - default policy (stage 3)', () => {
    test('all events play regardless of view state when focusOnly is off (opencode "always" default)', () => {
      const settings = buildSettings({ notificationSoundFocusOnly: false });
      for (const event of ALL_EVENTS) {
        expect(shouldPlaySoundForEvent(event, settings, true)).toBe(true);
        expect(shouldPlaySoundForEvent(event, settings, false)).toBe(true);
      }
    });
  });

  describe('focus gating - focusOnly override (stage 3)', () => {
    test('all events skip when viewed and focusOnly is on', () => {
      const settings = buildSettings({ notificationSoundFocusOnly: true });
      for (const event of ALL_EVENTS) {
        expect(shouldPlaySoundForEvent(event, settings, true)).toBe(false);
      }
    });

    test('all events play when unviewed and focusOnly is on', () => {
      const settings = buildSettings({ notificationSoundFocusOnly: true });
      for (const event of ALL_EVENTS) {
        expect(shouldPlaySoundForEvent(event, settings, false)).toBe(true);
      }
    });

    test('per-event toggle still applies before focusOnly', () => {
      const settings = buildSettings({ notificationSoundFocusOnly: true, notifyOnCompletion: false });
      // per-event toggle off -> false regardless of view state
      expect(shouldPlaySoundForEvent('completion', settings, false)).toBe(false);
    });
  });

  describe('gating order', () => {
    test('master -> per-event -> focusOnly is evaluated in that order', () => {
      // Master off: nothing plays.
      expect(
        shouldPlaySoundForEvent('completion', buildSettings({ notificationSoundEnabled: false }), true),
      ).toBe(false);
      // Master on, per-event off: nothing plays regardless of focus.
      expect(
        shouldPlaySoundForEvent('completion', buildSettings({ notifyOnCompletion: false, notificationSoundFocusOnly: true }), false),
      ).toBe(false);
      // Master on, per-event on, focusOnly on, viewed: nothing plays.
      expect(
        shouldPlaySoundForEvent('completion', buildSettings({ notificationSoundFocusOnly: true }), true),
      ).toBe(false);
      // Master on, per-event on, focusOnly on, unviewed: plays.
      expect(
        shouldPlaySoundForEvent('completion', buildSettings({ notificationSoundFocusOnly: true }), false),
      ).toBe(true);
    });
  });
});

describe('playSoundForEvent - sound id resolution', () => {
  test('constructs Audio when the configured sound id is valid', () => {
    const calls: string[] = [];
    const originalAudio = globalThis.Audio;
    try {
      globalThis.Audio = class {
        constructor(src: string) {
          calls.push(src);
        }
        volume = 1;
        play() {
          return Promise.resolve();
        }
      } as unknown as typeof Audio;

      const settings = buildSettings();
      playSoundForEvent('completion', settings, false);

      expect(calls.length).toBe(1);
      expect(typeof calls[0]).toBe('string');
      expect(calls[0].length).toBeGreaterThan(0);
    } finally {
      globalThis.Audio = originalAudio;
    }
  });

  test('falls back to the default sound when the configured id is null/undefined', () => {
    const calls: string[] = [];
    const originalAudio = globalThis.Audio;
    try {
      globalThis.Audio = class {
        constructor(src: string) {
          calls.push(src);
        }
        volume = 1;
        play() {
          return Promise.resolve();
        }
      } as unknown as typeof Audio;

      // completion is unset (undefined) -> `?? DEFAULT_EVENT_SOUNDS.completion`
      // resolves to a known id -> playback proceeds.
      const settings = buildSettings({
        notificationSoundEventSounds: { ...DEFAULT_EVENT_SOUNDS, completion: undefined as unknown as string },
      });
      playSoundForEvent('completion', settings, false);

      expect(calls.length).toBe(1);
    } finally {
      globalThis.Audio = originalAudio;
    }
  });

  test('skips playback when the configured sound id is unknown (not in the lookup table)', () => {
    const calls: string[] = [];
    const originalAudio = globalThis.Audio;
    try {
      globalThis.Audio = class {
        constructor(src: string) {
          calls.push(src);
        }
        volume = 1;
        play() {
          return Promise.resolve();
        }
      } as unknown as typeof Audio;

      // An unknown-but-present id is NOT replaced by the default; resolveSoundUrl
      // returns undefined and playback is skipped. This documents the contract.
      const settings = buildSettings({
        notificationSoundEventSounds: { ...DEFAULT_EVENT_SOUNDS, completion: 'does-not-exist-99' },
      });
      playSoundForEvent('completion', settings, false);

      expect(calls.length).toBe(0);
    } finally {
      globalThis.Audio = originalAudio;
    }
  });

  test('does not throw when Audio is unavailable', () => {
    const originalAudio = globalThis.Audio;
    try {
      // Simulate a non-browser context where Audio is undefined.
      (globalThis as { Audio?: typeof Audio }).Audio = undefined;
      const settings = buildSettings();
      let threw = false;
      try {
        playSoundForEvent('completion', settings, false);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      globalThis.Audio = originalAudio;
    }
  });

  test('does not play when gating rejects the event', () => {
    const calls: string[] = [];
    const originalAudio = globalThis.Audio;
    try {
      globalThis.Audio = class {
        constructor(src: string) {
          calls.push(src);
        }
        volume = 1;
        play() {
          return Promise.resolve();
        }
      } as unknown as typeof Audio;

      // Master toggle off -> gating rejects -> no Audio constructed.
      playSoundForEvent('completion', buildSettings({ notificationSoundEnabled: false }), false);
      expect(calls.length).toBe(0);
    } finally {
      globalThis.Audio = originalAudio;
    }
  });
});
