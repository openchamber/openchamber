import { expect, test } from 'bun:test';
import type { GitRemote, SourceControlIdentity } from '@/lib/api/types';
import { repositoryLinkFromRemotes } from './repositoryUrl';

const remote = (name: string, fetchUrl: string, pushUrl = fetchUrl): GitRemote => ({ name, fetchUrl, pushUrl });
const link = (url: string, identities: SourceControlIdentity[] = []) => repositoryLinkFromRemotes([remote('origin', url)], identities);

test('GitHub HTTPS and SSH endpoints become browser links without an account', () => {
  for (const url of ['https://github.com/team/repo.git/', 'https://github.com/team/repo', 'git@GitHub.com:team/repo.git', 'ssh://git@github.com/team/repo.git']) {
    expect(link(url)).toEqual({ provider: 'github', url: 'https://github.com/team/repo' });
  }
});

test('GitLab HTTPS and SSH endpoints preserve subgroups without an account', () => {
  for (const url of ['git@gitlab.com:group/sub/project.git', 'https://gitlab.com/group/sub/project.git/', 'ssh://git@gitlab.com/group/sub/project.git']) {
    expect(link(url)).toEqual({ provider: 'gitlab', url: 'https://gitlab.com/group/sub/project' });
  }
});

test('known self-hosted GitLab instances use their configured browser base', () => {
  const identities: SourceControlIdentity[] = [{ provider: 'gitlab', instance: 'https://code.example.com' }];
  expect(link('git@code.example.com:group/sub/project.git', identities)).toEqual({ provider: 'gitlab', url: 'https://code.example.com/group/sub/project' });
  expect(link('https://code.example.com/group/sub/project.git', identities)).toEqual({ provider: 'gitlab', url: 'https://code.example.com/group/sub/project' });
  expect(link('git@code.example.com:group/sub/project.git')).toBeNull();
});

test('configured instance ports and path prefixes are retained', () => {
  const identities: SourceControlIdentity[] = [{ provider: 'gitlab', instance: 'https://code.example.com:8443/gitlab' }];
  expect(link('https://code.example.com:8443/gitlab/group/project.git', identities)).toEqual({ provider: 'gitlab', url: 'https://code.example.com:8443/gitlab/group/project' });
});

test('unsupported hosts and malformed repository paths have no entry', () => {
  for (const url of ['', 'not a url', 'https://example.com/group/project', 'https://github.com/team', 'https://github.com/team/repo/tree/main', 'git@gitlab.com:group//repo.git', 'git@gitlab.com:group/../repo.git', 'git@gitlab.com:group/repo.git?token=secret', 'file://github.com/team/repo']) {
    expect(link(url)).toBeNull();
  }
  expect(repositoryLinkFromRemotes([], [])).toBeNull();
});

test('origin wins across providers and fetch wins over push', () => {
  expect(repositoryLinkFromRemotes([
    remote('upstream', 'https://github.com/upstream/project.git'),
    remote('origin', 'git@gitlab.com:group/sub/project.git', 'https://github.com/fork/project.git'),
  ], [])).toEqual({ provider: 'gitlab', url: 'https://gitlab.com/group/sub/project' });
});

test('unsupported origin falls back to another recognized remote or push endpoint', () => {
  expect(repositoryLinkFromRemotes([remote('origin', 'https://example.com/team/repo'), remote('upstream', 'https://gitlab.com/group/project.git')], []))
    .toEqual({ provider: 'gitlab', url: 'https://gitlab.com/group/project' });
  expect(repositoryLinkFromRemotes([remote('origin', '', 'git@github.com:team/repo.git')], []))
    .toEqual({ provider: 'github', url: 'https://github.com/team/repo' });
});
