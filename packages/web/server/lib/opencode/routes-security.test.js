import { describe, expect, it } from 'vitest';
import { hasSecureWorkspaceSettingsMutation } from './routes.js';

describe('generic settings security boundary', () => {
  it('detects every Secure Workspace mutation key while allowing unrelated settings', () => {
    expect(hasSecureWorkspaceSettingsMutation({ themeId: 'dark' })).toBe(false);
    expect(hasSecureWorkspaceSettingsMutation({ secureWorkspacesEnabled: true })).toBe(true);
    expect(hasSecureWorkspaceSettingsMutation({ secureWorkspacesImage: 'forged' })).toBe(true);
  });
});
