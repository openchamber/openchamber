import { describe, expect, it } from 'vitest';
import { parseGerritRemoteUrl, resolveGerritProjectsFromDirectory } from './repo.js';

const ORIGIN = 'https://gerrit.example.com';

describe('Gerrit remotes', () => {
  it('reads nested project names from HTTPS remotes, with or without the /a/ prefix', () => {
    expect(parseGerritRemoteUrl(`${ORIGIN}/platform/app`, ORIGIN)).toMatchObject({ owner: 'platform', name: 'app', project: 'platform/app' });
    expect(parseGerritRemoteUrl(`${ORIGIN}/a/platform/build/soong.git`, ORIGIN)).toMatchObject({ owner: 'platform/build', name: 'soong', project: 'platform/build/soong' });
  });

  it('reads SSH remotes on Gerrit\'s port and scp-like ones by hostname', () => {
    expect(parseGerritRemoteUrl('ssh://alice@gerrit.example.com:29418/platform/app', ORIGIN)).toMatchObject({ project: 'platform/app' });
    expect(parseGerritRemoteUrl('alice@gerrit.example.com:platform/app.git', ORIGIN)).toMatchObject({ project: 'platform/app' });
    // Over SSH a leading `a/` is a real path segment.
    expect(parseGerritRemoteUrl('ssh://gerrit.example.com:29418/a/app', ORIGIN)).toMatchObject({ project: 'a/app' });
  });

  it('refuses other hosts, ports, credentials in the URL, and unsafe paths', () => {
    expect(parseGerritRemoteUrl('https://elsewhere.example.com/platform/app', ORIGIN)).toBeNull();
    expect(parseGerritRemoteUrl('https://gerrit.example.com:8443/platform/app', ORIGIN)).toBeNull();
    expect(parseGerritRemoteUrl('https://alice:pw@gerrit.example.com/platform/app', ORIGIN)).toBeNull();
    expect(parseGerritRemoteUrl(`${ORIGIN}/platform/a~b`, ORIGIN)).toBeNull();
    expect(parseGerritRemoteUrl('gerrit.example.com:../app', ORIGIN)).toBeNull();
    expect(parseGerritRemoteUrl(`${ORIGIN}/`, ORIGIN)).toBeNull();
    expect(parseGerritRemoteUrl('http://gerrit.example.com/platform/app', ORIGIN)).toBeNull();
  });

  it('reads a top-level project with an empty owner, and splits deep paths on the last slash', () => {
    expect(parseGerritRemoteUrl(`${ORIGIN}/a/demo`, ORIGIN)).toMatchObject({ owner: '', name: 'demo', project: 'demo', url: `${ORIGIN}/admin/repos/demo` });
    expect(parseGerritRemoteUrl('ssh://gerrit.example.com:29418/demo.git', ORIGIN)).toMatchObject({ owner: '', name: 'demo' });
    expect(parseGerritRemoteUrl(`${ORIGIN}/team/app/sub`, ORIGIN)).toMatchObject({ owner: 'team/app', name: 'sub', project: 'team/app/sub' });
    expect(parseGerritRemoteUrl(`${ORIGIN}/a`, ORIGIN)).toMatchObject({ owner: '', name: 'a' });
  });

  it('accepts HTTP only for a loopback HTTP instance', () => {
    expect(parseGerritRemoteUrl('http://localhost:8080/a/platform/app', 'http://localhost:8080')).toMatchObject({ project: 'platform/app' });
  });

  it('resolves only the named remote when one is given, else ranks the remotes', async () => {
    const getRemotes = async () => [
      { name: 'origin', fetchUrl: `${ORIGIN}/platform/app`, pushUrl: `${ORIGIN}/platform/app` },
      { name: 'mirror', fetchUrl: 'https://github.com/platform/app', pushUrl: '' },
      { name: 'review', fetchUrl: 'ssh://gerrit.example.com:29418/platform/tools' },
    ];
    const getStatus = async () => ({ tracking: 'review/master' });
    await expect(resolveGerritProjectsFromDirectory('/repo', ORIGIN, 'mirror', { getRemotes, getStatus })).resolves.toEqual({ repos: [] });
    const ranked = await resolveGerritProjectsFromDirectory('/repo', ORIGIN, '', { getRemotes, getStatus });
    expect(ranked.repos.map((repo) => [repo.remoteName, repo.project])).toEqual([['review', 'platform/tools'], ['origin', 'platform/app']]);
  });
});
