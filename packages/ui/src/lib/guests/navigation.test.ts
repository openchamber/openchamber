import { describe, expect, test } from 'bun:test';

import { markMiniChatWindow } from '@/lib/miniChatWindow';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { guestNavigationEffects } from './navigation';

describe('guestNavigationEffects', () => {
  test('Mini Chat has no panel for Walkthrough, so it refuses before anything else and keeps the base', async () => {
    const open = () => guestNavigationEffects(() => '/repo').openWalkthrough('main');
    expect(await open()).toMatchObject({ ok: false, code: 'HOST_UNAVAILABLE' });
    markMiniChatWindow();
    expect(await open()).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(useGitBaseBranchStore.getState().overrides).toEqual({});
  });
});
