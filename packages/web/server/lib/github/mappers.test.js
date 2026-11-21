import { describe, expect, it } from 'vitest';
import { mapChangeRequest, mapReviewComment, requireGitHubPullRequest, requireGitHubCheckRuns } from './mappers.js';

const identity = { provider: 'github', instance: 'github.com' };
const project = { ...identity, id: 'acme/app', owner: 'acme', name: 'app', url: 'https://github.com/acme/app' };
const pull = { number: 7, title: 'Change', html_url: 'https://github.com/acme/app/pull/7', state: 'open',
  base: { ref: 'main' }, head: { ref: 'topic' } };

describe('GitHub mapper boundary checks', () => {
  it('keeps unvalidated pull fields without promising their representation', () => {
    const value = { ...pull, mergeable: 'yes', labels: { constructor: Array }.constructor };
    expect(requireGitHubPullRequest(value, 'invalid pull')).toBe(value);
    const mapped = mapChangeRequest(value, project, identity);
    expect(mapped.mergeable).toBeNull();
    expect(mapped).not.toHaveProperty('labels');
  });

  it('requires a real collection when a dictionary lookup names an inherited member', () => {
    const collections = {};
    expect(() => requireGitHubCheckRuns(collections.constructor)).toThrow('GitHub returned invalid check runs');
  });

  it('retains the primitive number rule for review lines and positions', () => {
    const comment = { id: 1, html_url: 'https://github.com/acme/app/pull/7#discussion_r1', body: 'Text', path: 'file.ts' };
    expect(mapReviewComment({ ...comment, line: '12', position: false }, identity)).toMatchObject({ line: null, position: null });
    const mapped = mapReviewComment({ ...comment, line: NaN, position: Infinity }, identity);
    expect(mapped.line).toBeNaN();
    expect(mapped.position).toBe(Infinity);
  });

  it('does not rewrite unchecked check-run fields during collection validation', () => {
    const runs = [{ id: 1, name: 'build', status: 'in_progress', started_at: 42 }];
    expect(requireGitHubCheckRuns(runs)).toBe(runs);
    expect(runs[0].started_at).toBe(42);
  });
});
