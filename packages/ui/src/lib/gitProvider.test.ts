import { describe, expect, test } from 'bun:test';
import { buildGitProviderHosts, detectGitProvider, type GitProviderHosts } from './gitProvider';

const EMPTY_HOSTS: GitProviderHosts = { github: [], gitlab: [], gitea: [] };

const emptyInput = {
  domains: { github: [], gitlab: [], gitea: [] },
  apiBaseUrls: { github: '', gitlab: '', gitea: '' },
};

describe('detectGitProvider', () => {
  test('returns null with no remotes', () => {
    expect(detectGitProvider([], EMPTY_HOSTS)).toBeNull();
  });

  test('classifies github.com remotes across URL forms', () => {
    expect(detectGitProvider(['git@github.com:owner/repo.git'], EMPTY_HOSTS)).toBe('github');
    expect(detectGitProvider(['ssh://git@github.com/owner/repo.git'], EMPTY_HOSTS)).toBe('github');
    expect(detectGitProvider(['https://github.com/owner/repo.git'], EMPTY_HOSTS)).toBe('github');
  });

  test('classifies gitlab.com remotes across URL forms', () => {
    expect(detectGitProvider(['git@gitlab.com:group/project.git'], EMPTY_HOSTS)).toBe('gitlab');
    expect(detectGitProvider(['ssh://git@gitlab.com/group/sub/project.git'], EMPTY_HOSTS)).toBe('gitlab');
    expect(detectGitProvider(['https://gitlab.com/group/project'], EMPTY_HOSTS)).toBe('gitlab');
  });

  test('classifies a self-hosted GitLab remote through configured hosts', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitlab: ['git.example.com'] };
    expect(detectGitProvider(['git@git.example.com:group/project.git'], hosts)).toBe('gitlab');
    expect(detectGitProvider(['https://git.example.com/group/project.git'], hosts)).toBe('gitlab');
  });

  test('does not classify an unknown self-hosted host as gitlab without a configured host', () => {
    expect(detectGitProvider(['git@git.example.com:group/project.git'], EMPTY_HOSTS)).toBe('other');
  });

  test('classifies other hosts as other', () => {
    expect(detectGitProvider(['git@gitea.example.com:owner/repo.git'], EMPTY_HOSTS)).toBe('other');
    expect(detectGitProvider(['https://bitbucket.org/owner/repo.git'], EMPTY_HOSTS)).toBe('other');
  });

  test('github wins when both github and gitlab remotes are present', () => {
    expect(detectGitProvider([
      'git@github.com:owner/repo.git',
      'git@gitlab.com:owner/repo.git',
    ], EMPTY_HOSTS)).toBe('github');
  });

  test('ignores malformed remotes', () => {
    expect(detectGitProvider(['', 'not a url', '   '], EMPTY_HOSTS)).toBeNull();
  });

  test('classifies a self-hosted Gitea remote across URL forms through configured hosts', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['gitea.example.com'] };
    expect(detectGitProvider(['git@gitea.example.com:owner/repo.git'], hosts)).toBe('gitea');
    expect(detectGitProvider(['ssh://git@gitea.example.com/owner/repo.git'], hosts)).toBe('gitea');
    expect(detectGitProvider(['https://gitea.example.com/owner/repo.git'], hosts)).toBe('gitea');
  });

  test('classifies codeberg.org remotes as gitea through configured hosts', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['codeberg.org'] };
    expect(detectGitProvider(['git@codeberg.org:owner/repo.git'], hosts)).toBe('gitea');
  });

  test('classifies a bare scp remote (no user) through configured gitea hosts', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['codeberg.org'] };
    expect(detectGitProvider(['codeberg.org:owner/repo.git'], hosts)).toBe('gitea');
  });

  test('classifies an ssh URL with a non-default port through configured gitea hosts', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['codeberg.org'] };
    expect(detectGitProvider(['ssh://git@codeberg.org:2222/owner/repo.git'], hosts)).toBe('gitea');
  });

  test('matches a custom domain entered as an scp remote against an ssh URL remote', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['git@ssh.example.com:org/repo.git'] };
    expect(detectGitProvider(['ssh://git@ssh.example.com/org/repo.git'], hosts)).toBe('gitea');
  });

  test('matches a custom domain entered bare against an scp remote', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['codeberg.org:owner/repo.git'] };
    expect(detectGitProvider(['git@codeberg.org:owner/repo.git'], hosts)).toBe('gitea');
  });

  test('classifies an IPv6 remote through a configured gitea host', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['2001:db8::1'] };
    expect(detectGitProvider(['ssh://git@[2001:db8::1]/owner/repo.git'], hosts)).toBe('gitea');
  });

  test('classifies codeberg.org as gitea by default (built-in host)', () => {
    expect(detectGitProvider(['git@codeberg.org:owner/repo.git'], EMPTY_HOSTS)).toBe('gitea');
    expect(detectGitProvider(['https://codeberg.org/owner/repo.git'], EMPTY_HOSTS)).toBe('gitea');
  });

  test('github wins over a configured gitea host when both remotes are present', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['gitea.example.com'] };
    expect(detectGitProvider([
      'git@github.com:owner/repo.git',
      'git@gitea.example.com:owner/repo.git',
    ], hosts)).toBe('github');
  });

  test('gitlab wins over a configured gitea host when both remotes are present', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, gitea: ['gitea.example.com'] };
    expect(detectGitProvider([
      'git@gitlab.com:group/project.git',
      'git@gitea.example.com:owner/repo.git',
    ], hosts)).toBe('gitlab');
  });

  test('custom github host wins over gitlab.com', () => {
    const hosts: GitProviderHosts = { ...EMPTY_HOSTS, github: ['github.example.com'] };
    expect(detectGitProvider([
      'git@github.example.com:owner/repo.git',
      'git@gitlab.com:group/project.git',
    ], hosts)).toBe('github');
  });

  test('normalizes host entries (scheme, port, and path stripped)', () => {
    const hosts: GitProviderHosts = {
      github: ['https://github.example.com/some/path', 'ssh://git@gh.other.example.com:2222/org'],
      gitlab: ['git@git.example.com:group/repo.git'],
      gitea: [],
    };
    expect(detectGitProvider(['https://github.example.com/owner/repo.git'], hosts)).toBe('github');
    expect(detectGitProvider(['https://gh.other.example.com/owner/repo.git'], hosts)).toBe('github');
    expect(detectGitProvider(['https://git.example.com/group/project.git'], hosts)).toBe('gitlab');
  });

  test('dedupes host entries', () => {
    const hosts: GitProviderHosts = {
      github: ['https://github.example.com/a', 'https://github.example.com/b'],
      gitlab: [],
      gitea: [],
    };
    expect(detectGitProvider(['git@github.example.com:owner/repo.git'], hosts)).toBe('github');
  });

  test('normalizes github.com built-in case-insensitively', () => {
    expect(detectGitProvider(['https://GITHUB.com/owner/repo.git'], EMPTY_HOSTS)).toBe('github');
  });
});

describe('buildGitProviderHosts', () => {
  test('adds no hosts when nothing is configured', () => {
    expect(buildGitProviderHosts(emptyInput)).toEqual(EMPTY_HOSTS);
  });

  test('auto-adds the github api base host so the provider is detected', () => {
    const hosts = buildGitProviderHosts({
      ...emptyInput,
      apiBaseUrls: { github: 'https://github.example.com/api/v3', gitlab: '', gitea: '' },
    });
    expect(hosts.github).toEqual(['github.example.com']);
    expect(detectGitProvider(['git@github.example.com:owner/repo.git'], hosts)).toBe('github');
  });

  test('a github api base of api.github.com maps to github.com and changes nothing', () => {
    const hosts = buildGitProviderHosts({
      ...emptyInput,
      apiBaseUrls: { github: 'https://api.github.com', gitlab: '', gitea: '' },
    });
    // github.com is already a built-in detection host; no behavior change.
    expect(hosts.github).toEqual(['github.com']);
    expect(detectGitProvider(['git@github.com:owner/repo.git'], hosts)).toBe('github');
    // The api host itself is not a web/remote host.
    expect(detectGitProvider(['git@api.github.com:owner/repo.git'], hosts)).toBe('other');
  });

  test('auto-adds the gitlab api base host so the provider is detected', () => {
    const hosts = buildGitProviderHosts({
      ...emptyInput,
      apiBaseUrls: { github: '', gitlab: 'https://gitlab.example.com', gitea: '' },
    });
    expect(hosts.gitlab).toEqual(['gitlab.example.com']);
    expect(detectGitProvider(['git@gitlab.example.com:group/project.git'], hosts)).toBe('gitlab');
  });

  test('auto-adds the gitea api base host so the provider is detected', () => {
    const hosts = buildGitProviderHosts({
      ...emptyInput,
      apiBaseUrls: { github: '', gitlab: '', gitea: 'https://gitea.example.com' },
    });
    expect(hosts.gitea).toEqual(['gitea.example.com']);
    expect(detectGitProvider(['git@gitea.example.com:owner/repo.git'], hosts)).toBe('gitea');
  });

  test('combines account base urls, api base host and custom domains, normalized and deduped', () => {
    const hosts = buildGitProviderHosts({
      domains: { github: [], gitlab: ['https://gitlab.example.com', 'gitlab.internal'], gitea: ['codeberg.org'] },
      apiBaseUrls: { github: '', gitlab: 'https://gitlab.example.com/', gitea: '' },
      gitlabAccounts: [{ baseUrl: 'https://gitlab.example.com' }, { baseUrl: 'ssh://git@gl.other.example.com/x' }],
      giteaAccounts: [{ baseUrl: 'https://gitea.example.com' }],
    });
    expect(hosts.gitlab).toEqual(['gitlab.example.com', 'gl.other.example.com', 'gitlab.internal']);
    expect(hosts.gitea).toEqual(['gitea.example.com', 'codeberg.org']);
    expect(hosts.github).toEqual([]);
  });

  test('dedupes the api base host against configured domains', () => {
    const hosts = buildGitProviderHosts({
      domains: { github: ['github.example.com'], gitlab: [], gitea: [] },
      apiBaseUrls: { github: 'https://github.example.com/api/v3', gitlab: '', gitea: '' },
    });
    expect(hosts.github).toEqual(['github.example.com']);
  });
});
