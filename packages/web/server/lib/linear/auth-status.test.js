import { describe, expect, it, vi } from 'vitest';
import { disconnectCurrentLinearWorkspace, readLinearAuthStatus, storeLinearAuthorization } from './auth-status.js';

describe('Linear auth status library boundary', () => {
  it('stores the inferred OAuth and identity values without strengthening their shape', async () => {
    const result = { accessToken: 'access', refreshToken: null, tokenType: 'bearer', expiresAt: 1, scope: '' };
    const identity = { user: { id: 17 }, organization: null };
    const libraries = {
      fetchLinearIdentity: vi.fn(async () => identity),
      setLinearAuth: vi.fn((input) => input),
    };

    expect(await storeLinearAuthorization(libraries, result)).toEqual({ ...result, ...identity });
    expect(libraries.fetchLinearIdentity).toHaveBeenCalledWith('access');
  });

  it.each([
    { status: 401 },
    Object.assign(new Error('Unauthorized'), { status: 401 }),
    Object.create({ status: 401 }),
  ])('removes only the failed workspace for an unauthorized rejection', async (failure) => {
    const auth = { workspaceId: 'failed', refreshToken: 'refresh' };
    const remaining = { workspaceId: 'remaining', accessToken: 'other' };
    const libraries = {
      pollAuthorizationBroker: vi.fn(async () => null),
      getValidLinearAccessToken: vi.fn(async () => 'access'),
      getLinearAuth: vi.fn().mockReturnValueOnce(auth).mockReturnValueOnce(remaining),
      fetchLinearIdentity: vi.fn(async () => { throw failure; }),
      clearLinearAuth: vi.fn(),
      getLinearAuthWorkspaces: vi.fn(() => []),
      toLinearPublicStatus: vi.fn(() => ({ connected: true })),
    };

    expect(await readLinearAuthStatus(libraries)).toEqual({ connected: true });
    expect(libraries.clearLinearAuth).toHaveBeenCalledWith('failed');
    expect(libraries.toLinearPublicStatus).toHaveBeenCalledWith(remaining, []);
  });

  it.each([null, undefined, 'offline', { status: 503 }])('retains stored auth on other failures', async (failure) => {
    const auth = { workspaceId: 'current', accessToken: 'access' };
    const libraries = {
      pollAuthorizationBroker: vi.fn(async () => null),
      getValidLinearAccessToken: vi.fn(async () => 'access'),
      getLinearAuth: vi.fn(() => auth),
      fetchLinearIdentity: vi.fn(async () => { throw failure; }),
      clearLinearAuth: vi.fn(),
      getLinearAuthWorkspaces: vi.fn(() => []),
      toLinearPublicStatus: vi.fn(() => ({ connected: true })),
    };

    expect(await readLinearAuthStatus(libraries)).toEqual({ connected: true });
    expect(libraries.clearLinearAuth).not.toHaveBeenCalled();
    expect(libraries.toLinearPublicStatus).toHaveBeenCalledWith(auth, []);
  });

  it('revokes the refresh token before removing the current workspace', async () => {
    const libraries = {
      getLinearAuth: vi.fn(() => ({ workspaceId: 'current', refreshToken: 'refresh', accessToken: 'access' })),
      revokeToken: vi.fn(async () => true),
      clearLinearAuth: vi.fn(() => true),
    };

    expect(await disconnectCurrentLinearWorkspace(libraries)).toBe(true);
    expect(libraries.revokeToken).toHaveBeenCalledWith('refresh', 'refresh_token');
    expect(libraries.clearLinearAuth).toHaveBeenCalledWith('current');
  });
});
