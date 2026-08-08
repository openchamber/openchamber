import { describe, expect, test } from 'bun:test';
import { createInitialSessionOverridePrefillGuard } from './useInitialSessionOverrides';

describe('initial session override prefill guard', () => {
  test('does not retry late agent prefill after a manual edit', () => {
    const guard = createInitialSessionOverridePrefillGuard();

    guard.markInitialSelection(false);
    guard.markManualEdit();

    expect(guard.shouldRetryForAgents(true)).toBe(false);
  });

  test('allows initial prefill again after a new-open or explicit-trigger reset', () => {
    const guard = createInitialSessionOverridePrefillGuard();

    guard.markInitialSelection(false);
    guard.markManualEdit();
    guard.reset();
    expect(guard.shouldRetryForAgents(true)).toBe(true);

    guard.markInitialSelection(true);
    expect(guard.shouldRetryForAgents(true)).toBe(false);
    guard.reset();
    expect(guard.shouldRetryForAgents(true)).toBe(true);
  });
});
