import { describe, expect, test } from 'bun:test';
import { useGitProviderDomainsStore } from './useGitProviderDomainsStore';

const resetDomains = () => {
  useGitProviderDomainsStore.setState({
    domains: { github: [], gitlab: [], gitea: [] },
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
});
