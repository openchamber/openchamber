import { beforeEach, describe, expect, test, vi } from 'vitest';

// getOctokitOrNull reads auth + config modules; mock them all so the base URL
// resolution can be asserted without a real token, data dir, or Octokit client.
const mockState = vi.hoisted(() => ({
  octokitConfigs: [],
  getGitHubAuth: vi.fn(),
  isGhCliActive: vi.fn(),
  isGhCliDisabled: vi.fn(),
  getGhCliToken: vi.fn(),
  getProviderApiBaseUrl: vi.fn(),
  getEffectiveProviderApiBaseUrl: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    constructor(config) {
      mockState.octokitConfigs.push(config);
    }
  },
}));

vi.mock('./auth.js', () => ({
  getGitHubAuth: mockState.getGitHubAuth,
  isGhCliActive: mockState.isGhCliActive,
  isGhCliDisabled: mockState.isGhCliDisabled,
}));

vi.mock('./gh-cli-credential.js', () => ({
  getGhCliToken: mockState.getGhCliToken,
}));

vi.mock('../git-providers/config.js', () => ({
  getProviderApiBaseUrl: mockState.getProviderApiBaseUrl,
}));

vi.mock('../git-providers/project-config.js', () => ({
  getEffectiveProviderApiBaseUrl: mockState.getEffectiveProviderApiBaseUrl,
}));

const { getOctokitOrNull } = await import('./octokit.js');

beforeEach(() => {
  mockState.octokitConfigs.length = 0;
  mockState.getGitHubAuth.mockReset();
  mockState.isGhCliActive.mockReset().mockReturnValue(false);
  mockState.isGhCliDisabled.mockReset().mockReturnValue(false);
  mockState.getGhCliToken.mockReset().mockReturnValue(null);
  mockState.getProviderApiBaseUrl.mockReset();
  mockState.getEffectiveProviderApiBaseUrl.mockReset();
});

describe('getOctokitOrNull base URL resolution', () => {
  test('uses the global base URL without a directory and never consults project overrides', () => {
    mockState.getGitHubAuth.mockReturnValue({ accessToken: 'ghp-test' });
    mockState.getProviderApiBaseUrl.mockReturnValue('https://api.github.com');

    const octokit = getOctokitOrNull();

    expect(octokit).not.toBeNull();
    expect(mockState.octokitConfigs).toHaveLength(1);
    expect(mockState.octokitConfigs[0].auth).toBe('ghp-test');
    expect(mockState.octokitConfigs[0].baseUrl).toBe('https://api.github.com');
    expect(mockState.getEffectiveProviderApiBaseUrl).not.toHaveBeenCalled();
  });

  test('resolves the per-project override base URL for a directory', () => {
    mockState.getGitHubAuth.mockReturnValue({ accessToken: 'ghp-test' });
    mockState.getEffectiveProviderApiBaseUrl.mockReturnValue('https://github.enterprise.example');

    const octokit = getOctokitOrNull('/work/override-project');

    expect(octokit).not.toBeNull();
    expect(mockState.getEffectiveProviderApiBaseUrl).toHaveBeenCalledWith('github', '/work/override-project');
    expect(mockState.octokitConfigs[0].baseUrl).toBe('https://github.enterprise.example');
  });

  test('returns null without a token', () => {
    mockState.getGitHubAuth.mockReturnValue(null);

    expect(getOctokitOrNull('/work/override-project')).toBeNull();
    expect(mockState.octokitConfigs).toHaveLength(0);
  });
});