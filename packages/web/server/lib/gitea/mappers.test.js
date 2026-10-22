import { describe, expect, it } from 'vitest';
import {
  asDraftTitle, asReadyTitle, isDraftTitle, liveChangeRequestSummary, mapGiteaCI, mapGiteaChangedFile, mapGiteaIssue,
  mapGiteaPull, mapGiteaRepo, mapGiteaVerdict, splitUnifiedDiff,
} from './mappers.js';
import { fixtures, ORIGIN } from './fixtures/fake-fetch.js';

const identity = { provider: 'gitea', instance: ORIGIN };

describe('Gitea mappers', () => {
  it('maps a repository with its numeric id as the project id', () => {
    expect(mapGiteaRepo(fixtures.upstreamRepo, identity, 'upstream')).toEqual({
      ...identity, id: '10', owner: 'team', name: 'app', url: `${ORIGIN}/team/app`,
      cloneUrl: `${ORIGIN}/team/app.git`, sshUrl: 'git@gitea.example.com:team/app.git', defaultBranch: 'main', remoteName: 'upstream',
    });
  });

  it('refuses a repository whose addresses are not on the instance or name another repository', () => {
    expect(mapGiteaRepo({ ...fixtures.upstreamRepo, html_url: 'https://elsewhere.example.com/team/app' }, identity)).toBeNull();
    expect(mapGiteaRepo({ ...fixtures.upstreamRepo, clone_url: `${ORIGIN}/team/other.git` }, identity)).toBeNull();
  });

  it('maps a fork pull request as a neutral change request', () => {
    const project = mapGiteaRepo(fixtures.upstreamRepo, identity);
    expect(mapGiteaPull(fixtures.forkPull, identity, project)).toMatchObject({
      id: '10#5', number: 5, state: 'open', draft: false, base: 'main', head: 'feature', headLabel: 'alice:feature',
      headSha: 'a'.repeat(40), mergeable: true, mergeableState: 'clean', labels: [{ name: 'bug', color: 'ee0701' }],
      author: { id: '7', username: 'alice' },
    });
    expect(mapGiteaPull({ ...fixtures.forkPull, merged: true, state: 'closed' }, identity, project).state).toBe('merged');
    expect(mapGiteaPull({ ...fixtures.forkPull, title: '[WIP] Add feature' }, identity, project).draft).toBe(true);
  });

  it('keeps pull requests out of issues', () => {
    const project = mapGiteaRepo(fixtures.forkRepo, identity);
    expect(mapGiteaIssue(fixtures.issue, identity, project)).toMatchObject({ id: '11#3', state: 'open', assignees: [{ username: 'alice' }] });
    expect(mapGiteaIssue({ ...fixtures.issue, pull_request: { merged: false } }, identity, project)).toBeNull();
  });

  it('writes and strips the draft prefixes Gitea recognizes', () => {
    expect(asDraftTitle('Add feature')).toBe('WIP: Add feature');
    expect(asDraftTitle('[WIP] Add feature')).toBe('[WIP] Add feature');
    expect(asReadyTitle('WIP: Add feature')).toBe('Add feature');
    expect(asReadyTitle('[wip] Add feature')).toBe('Add feature');
    expect(isDraftTitle('Wipe the cache')).toBe(false);
  });

  it('summarizes commit statuses as CI, a warning not failing it', () => {
    const ci = mapGiteaCI(fixtures.combinedStatus, identity);
    expect(ci.summary).toEqual({ state: 'pending', total: 2, success: 1, failure: 0, pending: 1 });
    expect(ci.runs[0]).toMatchObject({ name: 'ci / test (push)', conclusion: 'success', detailsUrl: `${ORIGIN}/team/app/actions/runs/1` });
    expect(mapGiteaCI({ statuses: [{ id: 1, status: 'warning' }, { id: 2, status: 'error' }] }, identity).summary.state).toBe('failure');
    expect(mapGiteaCI({ statuses: [], total_count: 0 }, identity)).toBeNull();
  });

  it('splits a pull request diff per file', () => {
    const parts = splitUnifiedDiff(fixtures.diff);
    expect([...parts.keys()]).toEqual(['src/app.js', 'old.txt']);
    expect(parts.get('src/app.js')).toMatch(/^diff --git a\/src\/app.js b\/src\/app.js\n/);
    expect(parts.get('old.txt')).toContain('-gone');
    expect(mapGiteaChangedFile(fixtures.files[1])).toEqual({ path: 'old.txt', status: 'removed', additions: 0, deletions: 1, changes: 1 });
  });

  it('reads verdicts still in force', () => {
    expect(mapGiteaVerdict(fixtures.reviews[0], identity)).toMatchObject({ state: 'approved', author: { username: 'bob' } });
    expect(mapGiteaVerdict(fixtures.reviews[1], identity)).toBeNull();
  });

  it('summarizes live state for the sidebar badge', () => {
    const ci = mapGiteaCI(fixtures.combinedStatus, identity);
    expect(liveChangeRequestSummary({ owner: 'team', repo: 'app', number: 5 }, fixtures.forkPull, ci)).toMatchObject({
      state: 'open', mergeable: true, mergeableState: 'clean', checks: { state: 'pending', total: 2 }, base: 'main',
    });
  });
});
