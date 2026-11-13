import { describe, expect, test } from 'bun:test';
import { parseSettingsDocument } from './registry';
import { DEFAULT_PR_FIX_LOOP_CONFIG } from '@/lib/prFixLoop';
import { buildSettingsSearchResults } from './search';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';

describe('PR automation settings contracts', () => {
  test('round-trips every fix-loop default and the conflict choice', () => {
    // Given
    const original = {
      prFixLoopDefaults: {
        ...DEFAULT_PR_FIX_LOOP_CONFIG, maxIterations: 23, tokenBudget: 42000,
        triggers: 'review', ignoreSelf: false, ignoreBots: false, allowAuthors: ['alice'],
        blockAuthors: ['bob'], mentionOnly: true, mentionText: '@review-helper', pushMode: 'approval',
      },
      prStackConflictMode: 'agent',
    };
    // When
    const parsed = parseSettingsDocument(JSON.parse(JSON.stringify(original)));
    // Then
    expect(parsed).toEqual(original);
  });

  test('preserves partial defaults without converting absent fields into defaults', () => {
    // Given
    const saved = { prFixLoopDefaults: { ignoreBots: false, tokenBudget: null } };
    // When
    const parsed = parseSettingsDocument(saved);
    // Then
    expect(parsed).toEqual(saved);
  });

  test('rejects malformed config independently of a valid conflict setting', () => {
    // Given
    const saved = { prFixLoopDefaults: { maxIterations: 51 }, prStackConflictMode: 'pause' };
    // When
    const parsed = parseSettingsDocument(saved);
    // Then
    expect(parsed).toEqual({ prStackConflictMode: 'pause' });
  });

  test('exposes fix-loop search controls on web and mobile but hides them in VS Code', () => {
    // Given
    const context = {
      isVSCode: false, isWeb: true, isDesktop: false, isMobile: false,
      isDesktopLocalOrigin: false, isMac: false, isWindows: false, isLinux: false,
      routingAvailable: false, enterpriseMode: false, jevBlockedByEnterprise: false,
    };
    // When
    for (const runtime of [context, { ...context, isMobile: true }, { ...context, isVSCode: true }]) {
      const results = buildSettingsSearchResults({ query: 'fix loop', runtimeCtx: runtime, sourceControlProviders: [githubLikeDescriptor()], t: (key) => key, getPageTitle: (page) => page });
      const controls = results.filter((result) => result.id.startsWith('integrations.pr-fix-loop'));
      // Then
      expect(controls).toHaveLength(runtime.isVSCode ? 0 : 12);
      expect(controls.every((result) => result.page === 'integrations')).toBe(true);
    }
  });
});
