import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitea-repo-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

vi.mock('../git/index.js', () => ({
  getRemoteUrl: vi.fn(async () => null),
}));

// Per-project overrides only apply for the directory configured with one; all
// other directories fall through to the real (global-only) resolution.
vi.mock('../git-providers/project-config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getEffectiveProviderApiBaseUrl: vi.fn((provider, directory) => {
      if (directory === '/override/project') {
        return provider === 'gitea' ? 'https://gitea.override.example' : actual.getEffectiveProviderApiBaseUrl(provider, directory);
      }
      return actual.getEffectiveProviderApiBaseUrl(provider, directory);
    }),
  };
});

const { parseGiteaRemoteUrl, resolveGiteaRepoFromDirectory } = await import('./repo.js');
const { getRemoteUrl } = await import('../git/index.js');
const { setGiteaAuth, clearGiteaAuth } = await import('./auth.js');

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
  clearGiteaAuth();
});

describe('parseGiteaRemoteUrl', () => {
  test('parses scp-like git@host:owner/repo.git', () => {
    expect(parseGiteaRemoteUrl('git@gitea.example.com:group/project.git', new Set(['gitea.example.com']))).toEqual({
      owner: 'group',
      repo: 'project',
      host: 'gitea.example.com',
      baseUrl: 'https://gitea.example.com',
      url: 'https://gitea.example.com/group/project',
    });
  });

  test('parses ssh:// URLs', () => {
    expect(parseGiteaRemoteUrl('ssh://git@gitea.example.com/owner/proj.git', new Set(['gitea.example.com']))).toMatchObject({
      owner: 'owner',
      repo: 'proj',
      host: 'gitea.example.com',
    });
  });

  test('parses https URLs with and without .git suffix', () => {
    expect(parseGiteaRemoteUrl('https://gitea.example.com/owner/proj.git', new Set(['gitea.example.com']))).toMatchObject({
      owner: 'owner',
      repo: 'proj',
      host: 'gitea.example.com',
    });
    expect(parseGiteaRemoteUrl('https://gitea.example.com/owner/proj', new Set(['gitea.example.com']))).toMatchObject({
      owner: 'owner',
      repo: 'proj',
    });
  });

  test('rejects multi-segment paths (Gitea repos are flat owner/repo)', () => {
    expect(parseGiteaRemoteUrl('git@gitea.example.com:a/b/c/proj.git', new Set(['gitea.example.com']))).toBeNull();
    expect(parseGiteaRemoteUrl('https://gitea.example.com/a/b/proj.git', new Set(['gitea.example.com']))).toBeNull();
  });

  test('rejects hosts not in knownHosts', () => {
    expect(parseGiteaRemoteUrl('git@gitea.example.com:owner/app.git', new Set(['other.example.com']))).toBeNull();
  });

  test('accepts hosts stored in auth accounts when knownHosts is omitted', () => {
    setGiteaAuth({
      accessToken: 'gitea-account-test',
      baseUrl: 'https://git.internal.example',
      user: { id: 1, login: 'worker' },
    });
    const result = parseGiteaRemoteUrl('git@git.internal.example:team/app.git');
    expect(result).toMatchObject({ host: 'git.internal.example', owner: 'team', repo: 'app' });
  });

  test('never accepts github.com or gitlab.com', () => {
    expect(parseGiteaRemoteUrl('git@github.com:owner/repo.git')).toBeNull();
    expect(parseGiteaRemoteUrl('git@gitlab.com:owner/repo.git')).toBeNull();
    expect(parseGiteaRemoteUrl('https://github.com/owner/repo.git', new Set(['github.com']))).toBeNull();
    expect(parseGiteaRemoteUrl('https://gitlab.com/owner/repo.git', new Set(['gitlab.com']))).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(parseGiteaRemoteUrl('')).toBeNull();
    expect(parseGiteaRemoteUrl('not a remote')).toBeNull();
    expect(parseGiteaRemoteUrl('git@gitea.example.com:onlyone')).toBeNull();
    expect(parseGiteaRemoteUrl(null)).toBeNull();
    expect(parseGiteaRemoteUrl(undefined)).toBeNull();
  });
});

describe('resolveGiteaRepoFromDirectory', () => {
  // Gitea has no default host, so directory resolution only accepts hosts from
  // stored accounts — set one up like a connected user would.
  beforeEach(() => {
    setGiteaAuth({
      accessToken: 'gitea-dir-test',
      baseUrl: 'https://gitea.example.com',
      user: { id: 1, login: 'worker' },
    });
  });

  test('resolves the repo from the origin remote', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('git@gitea.example.com:acme/widgets.git');
    const { repo, remoteUrl } = await resolveGiteaRepoFromDirectory('/some/project');
    expect(remoteUrl).toBe('git@gitea.example.com:acme/widgets.git');
    expect(repo).toMatchObject({ owner: 'acme', repo: 'widgets', host: 'gitea.example.com' });
  });

  test('uses a custom remote name', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('https://gitea.example.com/acme/widgets.git');
    await resolveGiteaRepoFromDirectory('/some/project', 'upstream');
    expect(getRemoteUrl).toHaveBeenCalledWith('/some/project', 'upstream');
  });

  test('returns null repo when the remote is not Gitea', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('git@github.com:owner/repo.git');
    const { repo, remoteUrl } = await resolveGiteaRepoFromDirectory('/some/project');
    expect(repo).toBeNull();
    expect(remoteUrl).toBe('git@github.com:owner/repo.git');
  });

  test('returns null when there is no remote URL', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue(null);
    const { repo, remoteUrl } = await resolveGiteaRepoFromDirectory('/some/project');
    expect(repo).toBeNull();
    expect(remoteUrl).toBeNull();
  });

  test('accepts the per-project override host for a directory with an override', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('git@gitea.override.example:team/app.git');
    const { repo, remoteUrl } = await resolveGiteaRepoFromDirectory('/override/project');
    expect(remoteUrl).toBe('git@gitea.override.example:team/app.git');
    expect(repo).toMatchObject({ owner: 'team', repo: 'app', host: 'gitea.override.example' });
  });

  test('rejects the override host for a directory without an override', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('git@gitea.override.example:team/app.git');
    const { repo } = await resolveGiteaRepoFromDirectory('/some/project');
    expect(repo).toBeNull();
  });
});
