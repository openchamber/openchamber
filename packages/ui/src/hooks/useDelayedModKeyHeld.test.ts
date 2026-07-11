import { describe, expect, test } from 'bun:test';
import {
  createDelayedModifierHintController,
  MODIFIER_SHORTCUT_HINT_DELAY_MS,
} from './useDelayedModKeyHeld';

describe('delayed modifier shortcut hints', () => {
  test('reveals only after 500ms and hides immediately on release', () => {
    const visibility: boolean[] = [];
    const scheduled: { callback: (() => void) | null } = { callback: null };
    let scheduledDelay = 0;
    let cancelled = false;
    const controller = createDelayedModifierHintController({
      setVisible: (visible) => visibility.push(visible),
      schedule: (callback, delayMs) => {
        scheduled.callback = callback;
        scheduledDelay = delayMs;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {
        cancelled = true;
      },
    });

    controller.press();
    expect(scheduledDelay).toBe(MODIFIER_SHORTCUT_HINT_DELAY_MS);
    expect(visibility).toEqual([]);

    scheduled.callback?.();
    expect(visibility).toEqual([true]);

    controller.release();
    expect(visibility).toEqual([true, false]);
    expect(cancelled).toBe(false);
  });

  test('cancels a pending reveal when the modifier is released early', () => {
    const visibility: boolean[] = [];
    const scheduled: { callback: (() => void) | null } = { callback: null };
    const controller = createDelayedModifierHintController({
      setVisible: (visible) => visibility.push(visible),
      schedule: (callback) => {
        scheduled.callback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
    });

    controller.press();
    controller.release();
    scheduled.callback?.();

    expect(visibility).toEqual([false]);
  });
});
