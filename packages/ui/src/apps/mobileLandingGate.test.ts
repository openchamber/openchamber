import { describe, expect, test } from 'bun:test';
import {
  shouldBypassLastSessionRestore,
  shouldShowRecentsLanding,
} from './mobileLandingGate';

const recentsPhoneInput = {
  mobileLandingMode: 'recents' as const,
  isTabletLayout: false,
  currentSessionId: null,
  draftOpen: false,
  landingDismissed: false,
  initialSessionRoutePending: false,
};

describe('shouldShowRecentsLanding', () => {
  test('Given recents mode with no suppression When evaluating the landing gate Then it shows recents', () => {
    const result = shouldShowRecentsLanding(recentsPhoneInput);

    expect(result).toBe(true);
  });

  const suppressions = [
    ['default mode', { mobileLandingMode: 'last-session' as const }],
    ['an open session', { currentSessionId: 'session-1' }],
    ['an open draft', { draftOpen: true }],
    ['tablet layout', { isTabletLayout: true }],
    ['a dismissed landing', { landingDismissed: true }],
    ['a pending deep link', { initialSessionRoutePending: true }],
  ] as const;

  for (const [condition, suppression] of suppressions) {
    test(`Given ${condition} When evaluating the landing gate Then it suppresses recents`, () => {
      const result = shouldShowRecentsLanding({ ...recentsPhoneInput, ...suppression });

      expect(result).toBe(false);
    });
  }
});

describe('shouldBypassLastSessionRestore', () => {
  const cases = [
    ['recents mode on a phone', { mobileLandingMode: 'recents' as const, isTabletLayout: false }, true],
    ['default mode on a phone', { mobileLandingMode: 'last-session' as const, isTabletLayout: false }, false],
    ['recents mode on a tablet', { mobileLandingMode: 'recents' as const, isTabletLayout: true }, false],
    ['default mode on a tablet', { mobileLandingMode: 'last-session' as const, isTabletLayout: true }, false],
  ] as const;

  for (const [condition, input, expected] of cases) {
    test(`Given ${condition} When evaluating the restore gate Then it returns ${expected}`, () => {
      const result = shouldBypassLastSessionRestore(input);

      expect(result).toBe(expected);
    });
  }
});
