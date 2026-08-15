import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, test, vi } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitlab-repo-'));
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
        return provider === 'gitlab' ? 'https://gitlab.override.example' : actual.getEffectiveProviderApiBaseUrl(provider, directory);
      }
      return actual.getEffectiveProviderApiBaseUrl(provider, directory);
    }),
  };
});

const { parseGitLabRemoteUrl, resolveGitLabRepoFromDirectory } = await import('./repo.js');
const { getRemoteUrl } = await import('../git/index.js');
const { setGitLabAuth, clearGitLabAuth } = await import('./auth.js');

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
  clearGitLabAuth();
});

describe('parseGitLabRemoteUrl', () => {
  test('parses scp-like git@host:ns/proj.git with a single segment', () => {
    expect(parseGitLabRemoteUrl('git@gitlab.com:group/project.git')).toEqual({
      namespace: 'group',
      project: 'project',
      host: 'gitlab.com',
      baseUrl: 'https://gitlab.com',
      url: 'https://gitlab.com/group/project',
    });
  });

  test('parses multi-segment namespaces', () => {
    expect(parseGitLabRemoteUrl('git@gitlab.com:a/b/c/proj.git')).toMatchObject({
      namespace: 'a/b/c',
      project: 'proj',
      host: 'gitlab.com',
      url: 'https://gitlab.com/a/b/c/proj',
    });
  });

  test('parses ssh:// URLs', () => {
    expect(parseGitLabRemoteUrl('ssh://git@gitlab.com/group/sub/proj.git')).toMatchObject({
      namespace: 'group/sub',
      project: 'proj',
      host: 'gitlab.com',
    });
  });

  test('parses https URLs with and without .git suffix', () => {
    expect(parseGitLabRemoteUrl('https://gitlab.com/group/proj.git')).toMatchObject({
      namespace: 'group',
      project: 'proj',
      host: 'gitlab.com',
    });
    expect(parseGitLabRemoteUrl('https://gitlab.com/group/proj')).toMatchObject({
      namespace: 'group',
      project: 'proj',
    });
  });

  test('accepts self-hosted hosts via knownHosts', () => {
    const result = parseGitLabRemoteUrl('git@git.example.com:team/app.git', new Set(['git.example.com']));
    expect(result).toMatchObject({ namespace: 'team', project: 'app', host: 'git.example.com' });
  });

  test('rejects hosts not in knownHosts', () => {
    expect(parseGitLabRemoteUrl('git@git.example.com:team/app.git', new Set(['other.example.com']))).toBeNull();
  });

  test('accepts hosts stored in auth accounts when knownHosts is omitted', () => {
    setGitLabAuth({
      accessToken: 'glpat-account-test',
      baseUrl: 'https://git.internal.example',
      user: { id: 1, username: 'worker' },
    });
    const result = parseGitLabRemoteUrl('git@git.internal.example:team/app.git');
    expect(result).toMatchObject({ host: 'git.internal.example', project: 'app' });
  });

  test('never accepts github.com', () => {
    expect(parseGitLabRemoteUrl('git@github.com:owner/repo.git')).toBeNull();
    expect(parseGitLabRemoteUrl('https://github.com/owner/repo.git', new Set(['github.com']))).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(parseGitLabRemoteUrl('')).toBeNull();
    expect(parseGitLabRemoteUrl('not a remote')).toBeNull();
    expect(parseGitLabRemoteUrl('git@gitlab.com:onlyone')).toBeNull();
    expect(parseGitLabRemoteUrl(null)).toBeNull();
    expect(parseGitLabRemoteUrl(undefined)).toBeNull();
  });
});

describe('resolveGitLabRepoFromDirectory', () => {
  test('resolves the repo from the origin remote', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('git@gitlab.com:acme/widgets.git');
    const { repo, remoteUrl } = await resolveGitLabRepoFromDirectory('/some/project');
    expect(remoteUrl).toBe('git@gitlab.com:acme/widgets.git');
    expect(repo).toMatchObject({ namespace: 'acme', project: 'widgets', host: 'gitlab.com' });
  });

  test('uses a custom remote name', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('https://gitlab.com/acme/widgets.git');
    await resolveGitLabRepoFromDirectory('/some/project', 'upstream');
    expect(getRemoteUrl).toHaveBeenCalledWith('/some/project', 'upstream');
  });

  test('returns null repo when the remote is not GitLab', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('git@github.com:owner/repo.git');
    const { repo, remoteUrl } = await resolveGitLabRepoFromDirectory('/some/project');
    expect(repo).toBeNull();
    expect(remoteUrl).toBe('git@github.com:owner/repo.git');
  });

  test('returns null when there is no remote URL', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue(null);
    const { repo, remoteUrl } = await resolveGitLabRepoFromDirectory('/some/project');
    expect(repo).toBeNull();
    expect(remoteUrl).toBeNull();
  });

  test('accepts the per-project override host for a directory with an override', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('git@gitlab.override.example:team/app.git');
    const { repo, remoteUrl } = await resolveGitLabRepoFromDirectory('/override/project');
    expect(remoteUrl).toBe('git@gitlab.override.example:team/app.git');
    expect(repo).toMatchObject({ namespace: 'team', project: 'app', host: 'gitlab.override.example' });
  });

  test('rejects the override host for a directory without an override', async () => {
    vi.mocked(getRemoteUrl).mockResolvedValue('git@gitlab.override.example:team/app.git');
    const { repo } = await resolveGitLabRepoFromDirectory('/some/project');
    expect(repo).toBeNull();
  });
});
