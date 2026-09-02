import { describe, expect, it } from 'vitest';

import { cleanBranchName, parseBranchSegment } from '../src/branchName.js';

describe('cleanBranchName', () => {
  it('strips refs/heads/', () => {
    expect(cleanBranchName('refs/heads/feature/cool')).toBe('feature/cool');
  });

  it('strips heads/', () => {
    expect(cleanBranchName('heads/feature/cool')).toBe('feature/cool');
  });

  it('strips refs/', () => {
    expect(cleanBranchName('refs/feature/cool')).toBe('feature/cool');
  });

  it('returns the input unchanged when no prefix is present', () => {
    expect(cleanBranchName('feature/cool')).toBe('feature/cool');
  });

  it('returns empty input unchanged', () => {
    expect(cleanBranchName('')).toBe('');
  });
});

describe('parseBranchSegment', () => {
  it('parses the bare <remote>/<branch> form', () => {
    expect(parseBranchSegment('origin/feature/cool')).toBe('feature/cool');
  });

  it('parses the remotes/<remote>/<branch> form', () => {
    expect(parseBranchSegment('remotes/origin/feature/cool')).toBe('feature/cool');
  });

  it('parses the refs/remotes/<remote>/<branch> form', () => {
    expect(parseBranchSegment('refs/remotes/origin/feature/cool')).toBe('feature/cool');
  });

  it('parses the refs/heads/<branch> form', () => {
    expect(parseBranchSegment('refs/heads/feature/cool')).toBe('feature/cool');
  });

  it('does not strip a non-heads refs prefix', () => {
    // `refs/tags/v1.0` is NOT one of the supported forms — falls through
    // to the bare `<segment>/<segment>` parser and yields `tags/v1.0` as
    // the "branch" value (matches the original parseRemoteBranchRef).
    expect(parseBranchSegment('refs/tags/v1.0')).toBe('tags/v1.0');
  });

  it('returns null when only the refs/heads/ prefix is present', () => {
    expect(parseBranchSegment('refs/heads/')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseBranchSegment('')).toBeNull();
    expect(parseBranchSegment('   ')).toBeNull();
  });

  it('returns null when there is no slash separator', () => {
    expect(parseBranchSegment('main')).toBeNull();
  });

  it('returns null when only the remote prefix is present', () => {
    expect(parseBranchSegment('origin/')).toBeNull();
  });
});
