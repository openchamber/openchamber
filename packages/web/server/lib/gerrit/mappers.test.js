import { describe, expect, it } from 'vitest';
import {
  diffOfPatch, gerritTimestamp, liveChangeSummary, mapGerritChange, mapGerritFiles, mapGerritMessage, mapGerritProject,
  mapGerritRelatedStack, mapGerritRevisions, mapGerritSubmitRequirements, mapGerritVoteLabels, patchsetRef, splitUnifiedDiff,
} from './mappers.js';
import { fixtures, ORIGIN, PS3 } from './fixtures/fake-fetch.js';

const identity = { provider: 'gerrit', instance: ORIGIN };
const project = mapGerritProject('platform/app', identity, { defaultBranch: 'master' });

describe('Gerrit mappers', () => {
  it('maps a nested project by its full name', () => {
    expect(project).toEqual({
      ...identity, id: 'platform/app', owner: 'platform', name: 'app', url: `${ORIGIN}/admin/repos/platform/app`,
      cloneUrl: `${ORIGIN}/a/platform/app`, defaultBranch: 'master',
    });
    expect(mapGerritProject('platform/build/soong', identity)).toMatchObject({ owner: 'platform/build', name: 'soong' });
    expect(mapGerritProject('demo', identity)).toMatchObject({ id: 'demo', owner: '', name: 'demo', url: `${ORIGIN}/admin/repos/demo`, cloneUrl: `${ORIGIN}/a/demo` });
    expect(mapGerritProject('team/app/sub', identity)).toMatchObject({ owner: 'team/app', name: 'sub' });
  });

  it('reads Gerrit timestamps as UTC', () => {
    expect(gerritTimestamp('2026-10-21 12:00:00.000000000')).toBe('2026-10-21T12:00:00.000Z');
    expect(gerritTimestamp('2026-10-21 12:00:00.5')).toBe('2026-10-21T12:00:00.500Z');
    expect(gerritTimestamp('2026-10-21T12:00:00Z')).toBeNull();
  });

  it('names patchset refs by the last two digits of the change', () => {
    expect(patchsetRef(42, 3)).toBe('refs/changes/42/42/3');
    expect(patchsetRef(5, 1)).toBe('refs/changes/05/5/1');
    expect(patchsetRef(12345, 2)).toBe('refs/changes/45/12345/2');
  });

  it('maps a change as a neutral change request', () => {
    expect(mapGerritChange(fixtures.change, identity, project)).toEqual({
      ...identity,
      id: 'platform/app#42',
      number: 42,
      project,
      title: 'Add login form',
      body: `Show the login form before the session check.\n\nChange-Id: ${fixtures.changeId}`,
      url: `${ORIGIN}/c/platform/app/+/42`,
      state: 'open',
      draft: false,
      base: 'master',
      head: 'refs/changes/42/42/3',
      headSha: PS3,
      headLabel: 'Patchset 3',
      revisionNumber: 3,
      labels: [{ name: 'ui' }],
      topic: 'login',
      author: { ...identity, id: '1000096', username: 'alice', name: 'Alice Admin', email: 'alice@example.invalid' },
      createdAt: '2026-10-22T17:52:13.000Z',
      updatedAt: '2026-10-22T17:52:14.000Z',
      mergeable: false,
      mergeableState: 'blocked',
    });
  });

  it('never reads ChangeInfo.id, whose shape differs between releases', () => {
    const demo = mapGerritProject('demo', identity);
    // 3.8.9: `demo~main~I…`; 3.10.9: `platform%2Fapp~42` with `triplet_id`.
    expect(fixtures.topLevelChange.id).toBe(`demo~main~${fixtures.topLevelChange.change_id}`);
    expect(fixtures.change).toMatchObject({ id: 'platform%2Fapp~42', triplet_id: `platform%2Fapp~master~${fixtures.changeId}` });
    expect(mapGerritChange(fixtures.topLevelChange, identity, demo)).toMatchObject({ id: 'demo#1', number: 1, url: `${ORIGIN}/c/demo/+/1`, head: 'refs/changes/01/1/2' });
    expect(mapGerritChange({ ...fixtures.change, id: 'garbage' }, identity, project)).toMatchObject({ id: 'platform/app#42' });
  });

  it('reads work in progress as a draft, private as a flag, and the change states', () => {
    const base = { ...fixtures.change, work_in_progress: true, is_private: true };
    expect(mapGerritChange(base, identity, project)).toMatchObject({ draft: true, private: true });
    expect(mapGerritChange({ ...base, status: 'MERGED' }, identity, project)).toMatchObject({ state: 'merged' });
    expect(mapGerritChange({ ...base, status: 'ABANDONED' }, identity, project)).toMatchObject({ state: 'closed' });
    expect(mapGerritChange({ ...base, status: 'MERGED' }, identity, project)).not.toHaveProperty('mergeable');
    expect(mapGerritChange({ ...base, project: 'other/app' }, identity, project)).toBeNull();
  });

  it('maps detailed labels to vote labels with the permitted range and non-zero votes', () => {
    const labels = mapGerritVoteLabels(fixtures.change, identity);
    expect(labels.map((label) => label.name)).toEqual(['Code-Review', 'Verified']);
    // Carol's zero in `all` only says she may vote.
    expect(labels[0]).toMatchObject({
      values: [-2, -1, 0, 1, 2].map((value) => expect.objectContaining({ value })),
      defaultValue: 0,
      permitted: [-2, -1, 0, 1, 2],
      blocking: false,
      status: 'recommended',
      votes: [{ user: expect.objectContaining({ username: 'bob' }), value: 1 }],
    });
    expect(labels[0].values[4]).toEqual({ value: 2, description: 'Looks good to me, approved' });
    expect(labels[1]).toMatchObject({ status: 'approved', permitted: [-1, 0, 1], votes: [{ value: 1 }] });
    const rejected = { ...fixtures.change, labels: { ...fixtures.change.labels, 'Code-Review': { ...fixtures.change.labels['Code-Review'], rejected: fixtures.accountSelf, blocking: true } } };
    expect(mapGerritVoteLabels(rejected, identity)[0]).toMatchObject({ status: 'rejected', blocking: true });
  });

  it('reads a label\'s status on 3.8 only when LABELS was asked beside DETAILED_LABELS', () => {
    const status = (raw) => mapGerritVoteLabels(raw, identity).map((label) => [label.name, label.status]);
    expect(status(fixtures.change_3_8)).toEqual([['Code-Review', 'recommended'], ['Verified', 'approved']]);
    // 3.8.9 answers DETAILED_LABELS alone without the summaries; 3.10.9 sends them either way.
    expect(status(fixtures.changeDetailedLabelsOnly_3_8)).toEqual([['Code-Review', 'neutral'], ['Verified', 'neutral']]);
  });

  it('maps submit requirements', () => {
    // A NoBlock label (Verified here) has no requirement; the legacy Code-Review one has no description.
    expect(mapGerritSubmitRequirements(fixtures.change)).toEqual([{ name: 'Code-Review', status: 'unsatisfied' }]);
    expect(mapGerritSubmitRequirements({ submit_requirements: [{ name: 'Z', status: 'SATISFIED', description: 'Needs a vote' }] }))
      .toEqual([{ name: 'Z', status: 'satisfied', description: 'Needs a vote' }]);
    expect(mapGerritSubmitRequirements({ submit_requirements: [{ name: 'X', status: 'NOT_APPLICABLE' }, { name: 'Y', status: 'TIMEOUT' }] }))
      .toEqual([{ name: 'X', status: 'not-applicable' }, { name: 'Y', status: 'error' }]);
  });

  it('lists patchsets oldest first with their kind, leaving a change edit out', () => {
    const revisions = mapGerritRevisions({ ...fixtures.change, revisions: { ...fixtures.change.revisions, ['f'.repeat(40)]: { _number: 'edit' } } }, identity);
    expect(revisions.map((revision) => [revision.number, revision.kind, revision.ref])).toEqual([
      [1, 'rework', 'refs/changes/42/42/1'], [2, 'rework', 'refs/changes/42/42/2'], [3, 'rework', 'refs/changes/42/42/3'],
    ]);
    expect(revisions[2]).toMatchObject({ sha: PS3, createdAt: '2026-10-22T17:52:13.000Z', uploader: { username: 'alice' } });
    const rebased = { ...fixtures.change.revisions[PS3], kind: 'TRIVIAL_REBASE' };
    expect(mapGerritRevisions({ ...fixtures.change, revisions: { [PS3]: rebased } }, identity)[0].kind).toBe('trivial-rebase');
  });

  it('maps change messages as comments with their patchset', () => {
    const message = fixtures.change.messages.find((entry) => entry.author._account_id === 1000097);
    expect(mapGerritMessage(message, identity, 'u')).toMatchObject({
      id: message.id, body: 'Patch Set 3: Code-Review+1\n\n(1 comment)\n\nNice, one nit inline.', revision: 3, author: { username: 'bob' }, createdAt: '2026-10-22T17:52:14.000Z',
    });
  });

  it('maps file statuses and leaves the magic paths out', () => {
    expect(mapGerritFiles(fixtures.files)).toEqual([
      { path: 'src/old.js', status: 'removed', additions: 0, deletions: 1, changes: 1 },
      { path: 'docs/login.md', status: 'added', additions: 3, deletions: 0, changes: 3 },
      { path: 'src/login.js', status: 'modified', additions: 4, deletions: 2, changes: 6 },
      { path: 'src/session.js', status: 'renamed', previousPath: 'src/auth.js', additions: 0, deletions: 0, changes: 0 },
    ]);
    // Copies and rewrites were never answered as C or W by 3.8.9 or 3.10.9 (they read as A and modified).
    expect(mapGerritFiles({ a: { status: 'C', old_path: 'b' }, c: { status: 'W' } })).toEqual([
      { path: 'a', status: 'added', previousPath: 'b', additions: 0, deletions: 0, changes: 0 },
      { path: 'c', status: 'modified', additions: 0, deletions: 0, changes: 0 },
    ]);
  });

  it('takes the diff out of a format-patch mail and splits it per file', () => {
    const diff = diffOfPatch(Buffer.from(fixtures.patch, 'base64').toString('utf8'));
    expect(diff.startsWith('diff --git a/docs/login.md')).toBe(true);
    expect(diff).not.toContain('Change-Id');
    expect(diff.endsWith('+  return true;\n+}\n')).toBe(true);
    // Gerrit's /patch has no rename detection: a rename is a deletion and an addition.
    expect([...splitUnifiedDiff(diff).keys()]).toEqual(['docs/login.md', 'src/auth.js', 'src/login.js', 'src/old.js', 'src/session.js']);
    expect(diffOfPatch('From x\n---\n\ndiff --git a/a b/a\n+x\n-- \n2.43.0\n\n')).toBe('diff --git a/a b/a\n+x\n');
  });

  it('turns a relation chain into a stack, bottom first', () => {
    expect(mapGerritRelatedStack(fixtures.related, { origin: ORIGIN, project: 'platform/app', base: 'master' })).toEqual({
      number: null,
      base: 'master',
      layers: [
        { number: 41, title: 'Extract session module', url: `${ORIGIN}/c/platform/app/+/41`, state: 'open', draft: false, head: 'refs/changes/41/41/1' },
        { number: 42, title: 'Add login form', url: `${ORIGIN}/c/platform/app/+/42`, state: 'open', draft: false, head: 'refs/changes/42/42/3' },
        { number: 43, title: 'Remember the user', url: `${ORIGIN}/c/platform/app/+/43`, state: 'open', draft: false, head: 'refs/changes/43/43/1' },
      ],
    });
    expect(mapGerritRelatedStack(fixtures.relatedNone, { origin: ORIGIN, project: 'platform/app', base: 'master' })).toBeNull();
  });

  it('summarizes a change for live badges', () => {
    expect(liveChangeSummary({ owner: 'platform', repo: 'app' }, { ...fixtures.change, submittable: true })).toEqual({
      owner: 'platform', repo: 'app', number: 42, state: 'open', draft: false, title: 'Add login form',
      mergeable: true, mergeableState: 'clean', checks: null, headSha: PS3, base: 'master',
    });
  });
});
