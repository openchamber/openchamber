import { describe, expect, it } from 'vitest';
import { mapGitLabCI, mapGitLabDiff, mapGitLabIssue, mapGitLabMergeRequest, mapGitLabNote, mapGitLabProject } from './mappers.js';

const identity = { provider: 'gitlab', instance: 'https://gitlab.example.com' };
const projectPayload = { id: 7, path_with_namespace: 'group/team/repo', web_url: 'https://gitlab.example.com/group/team/repo', default_branch: 'main' };

describe('GitLab provider mappers', () => {
  it('maps subgroup projects and merge requests into shared DTOs', () => {
    const project = mapGitLabProject(projectPayload, identity, 'origin');
    expect(project).toMatchObject({ ...identity, id: '7', owner: 'group/team', name: 'repo', defaultBranch: 'main', remoteName: 'origin' });
    expect(mapGitLabMergeRequest({
      iid: 12, title: 'Feature', web_url: 'https://gitlab.example.com/group/team/repo/-/merge_requests/12', state: 'opened',
      source_branch: 'feature', target_branch: 'main', draft: true, detailed_merge_status: 'mergeable', sha: 'abc',
      author: { id: 2, username: 'alex' },
    }, identity, project)).toMatchObject({ number: 12, state: 'open', draft: true, base: 'main', head: 'feature', mergeable: true, author: { id: '2', username: 'alex' } });
  });

  it('rejects project URLs outside the provider instance or project path', () => {
    expect(mapGitLabProject({
      ...projectPayload,
      http_url_to_repo: 'https://127.0.0.1/internal.git',
    }, identity)).toBeNull();
    expect(mapGitLabProject({
      ...projectPayload,
      ssh_url_to_repo: 'git@gitlab.example.com:other/repo.git',
    }, identity)).toBeNull();
  });

  it('maps issues without confusing incidents or malformed entries', () => {
    const project = mapGitLabProject(projectPayload, identity);
    expect(mapGitLabIssue({ iid: 3, title: 'Bug', web_url: 'https://gitlab.example.com/x/-/issues/3', state: 'opened', labels: ['bug', { name: 'P1', color: '#ff0000' }] }, identity, project))
      .toMatchObject({ number: 3, state: 'open', labels: [{ name: 'bug' }, { name: 'P1', color: 'ff0000' }] });
    expect(mapGitLabIssue({ iid: 4, title: 'Incident', web_url: 'x', state: 'opened', issue_type: 'incident' }, identity, project)).toBeNull();
  });

  it('filters system notes and retains line positions', () => {
    expect(mapGitLabNote({ id: 1, body: 'changed title', system: true }, identity)).toBeNull();
    expect(mapGitLabNote({ id: 2, body: 'Review', author: { id: 2, username: 'alex' }, position: { new_path: 'src/a.ts', new_line: 8 } }, identity, 'mr-url'))
      .toMatchObject({ id: '2', body: 'Review', path: 'src/a.ts', line: 8, url: 'mr-url' });
  });

  it('maps diffs and aggregates pipeline jobs', () => {
    expect(mapGitLabDiff({ new_path: 'src/new.ts', old_path: 'src/old.ts', renamed_file: true, diff: '@@' }))
      .toEqual({ path: 'src/new.ts', status: 'renamed', patch: '@@' });
    expect(mapGitLabCI({ id: 9, status: 'running', started_at: '2026-01-01T00:00:00Z' }, [
      { id: 1, name: 'test', status: 'success' }, { id: 2, name: 'lint', status: 'running' },
    ], identity)).toMatchObject({ summary: { state: 'pending', total: 2, success: 1, failure: 0, pending: 1 }, runs: [{ name: 'test' }, { name: 'lint' }] });
  });
});
