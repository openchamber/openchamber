import { describe, expect, test } from 'bun:test';

import { resolveStatusCheckFailureState } from './sessionAuthGateState';

describe('resolveStatusCheckFailureState', () => {
  test('keeps the desktop-shell password login fallback intact', () => {
    expect(resolveStatusCheckFailureState({ shouldUseDesktopShellPasswordLogin: true })).toBe('locked');
  });

  test('uses the network error screen for non-desktop status-check failures', () => {
    expect(resolveStatusCheckFailureState({})).toBe('error');
  });
});
