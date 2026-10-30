import { describe, expect, it } from 'vitest';
import {
  asDraftTitle, asReadyTitle, isDraftTitle, liveChangeRequestSummary, mapGiteaCI, mapGiteaChangedFile, mapGiteaIssue,
  mapGiteaPull, mapGiteaRepo, mapGiteaVerdict, splitUnifiedDiff,
} from './mappers.js';
import { fixtures, HEAD, ORIGIN } from './fixtures/fake-fetch.js';

const identity = { provider: 'gitea', instance: ORIGIN };

describe('Gitea mappers', () => {
  it('maps a repository with its numeric id as the project id', () => {
    expect(mapGiteaRepo(fixtures.upstreamRepo, identity, 'upstream')).toEqual({
      ...identity, id: '1', owner: 'alice', name: 'app', url: `${ORIGIN}/alice/app`,
      cloneUrl: `${ORIGIN}/alice/app.git`, sshUrl: 'git@gitea.example.com:alice/app.git', defaultBranch: 'main', remoteName: 'upstream',
    });
  });

  it('refuses a repository whose addresses are not on the instance or name another repository', () => {
    expect(mapGiteaRepo({ ...fixtures.upstreamRepo, html_url: 'https://elsewhere.example.com/alice/app' }, identity)).toBeNull();
    expect(mapGiteaRepo({ ...fixtures.upstreamRepo, clone_url: `${ORIGIN}/alice/other.git` }, identity)).toBeNull();
  });

  it('maps a fork pull request as a neutral change request', () => {
    const project = mapGiteaRepo(fixtures.upstreamRepo, identity);
    expect(mapGiteaPull(fixtures.forkPull, identity, project)).toMatchObject({
      id: '1#1', number: 1, state: 'open', draft: false, base: 'main', head: 'feature',
      headSha: HEAD, mergeable: true, mergeableState: 'clean', labels: [{ name: 'bug', color: 'ee0701' }],
      author: { id: '2', username: 'bob' },
    });
    expect(mapGiteaPull({ ...fixtures.forkPull, merged: true, state: 'closed' }, identity, project).state).toBe('merged');
    expect(mapGiteaPull({ ...fixtures.forkPull, title: '[WIP] Add feature' }, identity, project).draft).toBe(true);
  });

  it('labels a fork head owner:branch, though Gitea labels it with the bare branch', () => {
    const project = mapGiteaRepo(fixtures.upstreamRepo, identity);
    expect(fixtures.forkPull.head.label).toBe('feature');
    expect(mapGiteaPull(fixtures.forkPull, identity, project).headLabel).toBe('bob:feature');
    expect(mapGiteaPull({ ...fixtures.forkPull, head: { ...fixtures.forkPull.head, repo: null } }, identity, project).headLabel).toBeUndefined();
  });

  it('maps a 1.21 pull request, which has no draft flag, by its title', () => {
    const project = mapGiteaRepo(fixtures.upstreamRepo, identity);
    expect(fixtures.forkPull_1_21).not.toHaveProperty('draft');
    expect(mapGiteaPull(fixtures.forkPull_1_21, identity, project)).toMatchObject({ number: 1, draft: false, head: 'feature', headLabel: 'bob:feature' });
    expect(mapGiteaPull({ ...fixtures.forkPull_1_21, title: 'WIP: Add feature' }, identity, project).draft).toBe(true);
  });

  it('keeps pull requests out of issues', () => {
    const project = mapGiteaRepo(fixtures.upstreamRepo, identity);
    expect(mapGiteaIssue(fixtures.issue, identity, project)).toMatchObject({ id: '1#6', state: 'open', assignees: [{ username: 'alice' }] });
    expect(mapGiteaIssue({ ...fixtures.issue, pull_request: { merged: false } }, identity, project)).toBeNull();
  });

  it('writes and strips the draft prefixes Gitea recognizes', () => {
    expect(asDraftTitle('Add feature')).toBe('WIP: Add feature');
    expect(asDraftTitle('[WIP] Add feature')).toBe('[WIP] Add feature');
    expect(asReadyTitle('WIP: Add feature')).toBe('Add feature');
    expect(asReadyTitle('[wip] Add feature')).toBe('Add feature');
    expect(isDraftTitle('Wipe the cache')).toBe(false);
  });

  it('summarizes commit statuses as CI', () => {
    const ci = mapGiteaCI(fixtures.combinedStatus, identity);
    expect(ci.summary).toEqual({ state: 'pending', total: 2, success: 1, failure: 0, pending: 1 });
    expect(ci.runs[0]).toMatchObject({ name: 'base ci', conclusion: 'success' });
    // Gitea answers no statuses as `statuses: null` (state `pending` on 1.27, empty on 1.21).
    expect(mapGiteaCI(fixtures.combinedStatusEmpty, identity)).toBeNull();
    expect(mapGiteaCI(fixtures.combinedStatusEmpty_1_21, identity)).toBeNull();
  });

  it('fails CI on a warning, as Gitea\'s own combined state does', () => {
    expect(fixtures.combinedStatusWarning.state).toBe('failure');
    expect(fixtures.combinedStatusWarning_1_21.state).toBe('warning');
    for (const combined of [fixtures.combinedStatusWarning, fixtures.combinedStatusWarning_1_21]) {
      const ci = mapGiteaCI(combined, identity);
      expect(ci.summary).toEqual({ state: 'failure', total: 3, success: 1, failure: 1, pending: 1 });
      expect(ci.runs.find((run) => run.name === 'ci / warn')).toMatchObject({ conclusion: 'failure' });
      expect(ci.runs.find((run) => run.name === 'ci / test (push)')).toMatchObject({ detailsUrl: expect.stringMatching(/^https:\/\/gitea\.example\.com\//) });
    }
  });

  it('resolves a relative Actions target_url against the instance, keeping only an http(s) one', () => {
    const status = fixtures.combinedStatus.statuses[0];
    const run = (target_url) => mapGiteaCI({ statuses: [{ ...status, target_url }] }, identity).runs[0];
    expect(run('/alice/app/actions/runs/1').detailsUrl).toBe(`${ORIGIN}/alice/app/actions/runs/1`);
    expect(run(`${ORIGIN}/alice/app/actions/runs/1`).detailsUrl).toBe(`${ORIGIN}/alice/app/actions/runs/1`);
    expect(run('https://ci.example.com/job/1').detailsUrl).toBe('https://ci.example.com/job/1');
    expect(run('http://ci.example.com/job/1').detailsUrl).toBe('http://ci.example.com/job/1');
    expect(run('javascript:alert(1)').detailsUrl).toBeUndefined();
    expect(run('https://[').detailsUrl).toBeUndefined();
    expect(run('').detailsUrl).toBeUndefined();
    expect(run(undefined)).toMatchObject({ id: String(status.id), name: status.context, conclusion: 'success' });
    expect(run(undefined).detailsUrl).toBeUndefined();
  });

  it('splits a pull request diff per file, a rename by its new path', () => {
    const parts = splitUnifiedDiff(fixtures.mixedDiff);
    expect([...parts.keys()]).toEqual(['README.md', 'old.txt', 'src/main.js']);
    expect(parts.get('README.md')).toMatch(/^diff --git a\/README.md b\/README.md\n/);
    expect(parts.get('old.txt')).toContain('-main side');
    expect(parts.get('src/main.js')).toContain('rename from src/app.js');
    expect(fixtures.mixedFiles.map(mapGiteaChangedFile)).toEqual([
      { path: 'README.md', status: 'modified', additions: 1, deletions: 1, changes: 2 },
      { path: 'old.txt', status: 'removed', additions: 0, deletions: 1, changes: 1 },
      { path: 'src/main.js', status: 'renamed', additions: 0, deletions: 0, changes: 0 },
    ]);
  });

  it('reads verdicts still in force', () => {
    expect(mapGiteaVerdict(fixtures.reviews[0], identity)).toMatchObject({ state: 'approved', author: { username: 'alice' } });
    expect(mapGiteaVerdict({ ...fixtures.reviews[0], dismissed: true }, identity)).toBeNull();
    // A line comment is a COMMENT review, not a verdict.
    expect(fixtures.reviews[1].state).toBe('COMMENT');
    expect(mapGiteaVerdict(fixtures.reviews[1], identity)).toBeNull();
  });

  it('summarizes live state for the sidebar badge', () => {
    const ci = mapGiteaCI(fixtures.combinedStatus, identity);
    expect(liveChangeRequestSummary({ owner: 'alice', repo: 'app', number: 1 }, fixtures.forkPull, ci)).toMatchObject({
      state: 'open', mergeable: true, mergeableState: 'clean', checks: { state: 'pending', total: 2 }, base: 'main', headSha: HEAD,
    });
  });
});
