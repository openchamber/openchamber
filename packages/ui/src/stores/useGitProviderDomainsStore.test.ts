import { describe, expect, test } from 'bun:test';
import { useGitProviderDomainsStore } from './useGitProviderDomainsStore';

const resetDomains = () => {
  useGitProviderDomainsStore.setState({
    domains: { github: [], gitlab: [], gitea: [] },
    apiBaseUrls: { github: '', gitlab: '', gitea: '' },
  });
};

describe('useGitProviderDomainsStore', () => {
  test('normalizes and dedupes custom domains into bare hostnames', () => {
    resetDomains();
    useGitProviderDomainsStore.getState().setDomains('gitea', [
      'git@codeberg.org:owner/repo.git',
      'ssh://git@gitea.example.com:2222/o/r.git',
      'https://g.example.com/x',
      '  git.example.org  ',
    ]);
    expect(useGitProviderDomainsStore.getState().domains.gitea).toEqual([
      'codeberg.org',
      'gitea.example.com',
      'g.example.com',
      'git.example.org',
    ]);
  });

  test('drops unparseable and duplicate entries', () => {
    resetDomains();
    useGitProviderDomainsStore.getState().setDomains('gitlab', [
      'git@gitlab.example.com:group/repo.git',
      'git@gitlab.example.com:group/repo.git',
      '',
      '   ',
      'not a url',
      'C:\\foo',
    ]);
    expect(useGitProviderDomainsStore.getState().domains.gitlab).toEqual(['gitlab.example.com']);
  });

  test('setApiBaseUrl defaults to an empty string', () => {
    resetDomains();
    const store = useGitProviderDomainsStore.getState();
    store.setApiBaseUrl('github', '');
    store.setApiBaseUrl('gitlab', '   ');
    expect(useGitProviderDomainsStore.getState().apiBaseUrls).toEqual({
      github: '',
      gitlab: '',
      gitea: '',
    });
  });

  test('setApiBaseUrl strips trailing slashes but keeps scheme and path', () => {
    resetDomains();
    const store = useGitProviderDomainsStore.getState();
    store.setApiBaseUrl('github', ' https://github.example.com/api/v3/ ');
    store.setApiBaseUrl('gitlab', 'https://gitlab.example.com');
    store.setApiBaseUrl('gitea', 'gitea.example.com/path//');
    expect(useGitProviderDomainsStore.getState().apiBaseUrls).toEqual({
      github: 'https://github.example.com/api/v3',
      gitlab: 'https://gitlab.example.com',
      gitea: 'gitea.example.com/path',
    });
  });

  test('hydrateFromServer sets apiBaseUrls and domains from the server config', () => {
    resetDomains();
    useGitProviderDomainsStore.getState().hydrateFromServer({
      github: { apiBaseUrl: 'https://github.example.com/api/v3/', detectUrls: ['github.example.com', 'ssh://git@gh.example.com/x'] },
      gitlab: { detectUrls: [] },
    });
    const { domains, apiBaseUrls } = useGitProviderDomainsStore.getState();
    expect(apiBaseUrls).toEqual({
      github: 'https://github.example.com/api/v3',
      gitlab: '',
      gitea: '',
    });
    expect(domains.github).toEqual(['github.example.com', 'gh.example.com']);
    expect(domains.gitlab).toEqual([]);
    expect(domains.gitea).toEqual([]);
  });

  test('hydrateFromServer ignores malformed config', () => {
    resetDomains();
    useGitProviderDomainsStore.getState().hydrateFromServer({
      github: 'not an object',
      gitlab: { apiBaseUrl: 42, detectUrls: 'nope' },
    });
    const { domains, apiBaseUrls } = useGitProviderDomainsStore.getState();
    expect(apiBaseUrls).toEqual({ github: '', gitlab: '', gitea: '' });
    expect(domains).toEqual({ github: [], gitlab: [], gitea: [] });
  });

  test('hydrateFromServer with no config keeps cached domains and clears nothing', () => {
    resetDomains();
    useGitProviderDomainsStore.getState().setDomains('github', ['github.example.com']);
    useGitProviderDomainsStore.getState().setApiBaseUrl('github', 'https://github.example.com/api/v3');
    useGitProviderDomainsStore.getState().hydrateFromServer(undefined);
    const { domains, apiBaseUrls } = useGitProviderDomainsStore.getState();
    expect(domains.github).toEqual(['github.example.com']);
    expect(apiBaseUrls.github).toBe('');
  });

  test('server detect urls win over cached domains', () => {
    resetDomains();
    useGitProviderDomainsStore.getState().setDomains('gitea', ['codeberg.org']);
    useGitProviderDomainsStore.getState().hydrateFromServer({
      gitea: { detectUrls: ['gitea.example.com'] },
    });
    expect(useGitProviderDomainsStore.getState().domains.gitea).toEqual(['gitea.example.com']);
  });

  test('migration keeps cached domains when the server lacks detect urls', () => {
    resetDomains();
    useGitProviderDomainsStore.getState().setDomains('gitea', ['codeberg.org']);
    useGitProviderDomainsStore.getState().hydrateFromServer({
      gitea: { apiBaseUrl: 'https://gitea.example.com/api/v1' },
    });
    const { domains, apiBaseUrls } = useGitProviderDomainsStore.getState();
    // Server provided an api base but no detect urls: cached domains survive.
    expect(domains.gitea).toEqual(['codeberg.org']);
    expect(apiBaseUrls.gitea).toBe('https://gitea.example.com/api/v1');
  });

  test('migration applies per provider: configured providers win, cached ones survive', () => {
    resetDomains();
    useGitProviderDomainsStore.getState().setDomains('github', ['gh.example.com']);
    useGitProviderDomainsStore.getState().setDomains('gitlab', ['gitlab.example.com']);
    useGitProviderDomainsStore.getState().hydrateFromServer({
      github: { detectUrls: ['github.example.com'] },
    });
    const { domains } = useGitProviderDomainsStore.getState();
    expect(domains.github).toEqual(['github.example.com']);
    expect(domains.gitlab).toEqual(['gitlab.example.com']);
    expect(domains.gitea).toEqual([]);
  });
});
