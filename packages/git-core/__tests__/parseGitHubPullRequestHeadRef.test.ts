import { describe, expect, it } from 'vitest';

import { parseGitHubPullRequestHeadRef } from '../src/parseGitHubPullRequestHeadRef.js';

describe('parseGitHubPullRequestHeadRef', () => {
  it('parses positive numeric values', () => {
    expect(parseGitHubPullRequestHeadRef(42)).toEqual({
      number: 42,
      sourceRef: 'refs/pull/42/head',
    });
  });

  it('parses numeric strings', () => {
    expect(parseGitHubPullRequestHeadRef('123')).toEqual({
      number: 123,
      sourceRef: 'refs/pull/123/head',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseGitHubPullRequestHeadRef('  7  ')).toEqual({
      number: 7,
      sourceRef: 'refs/pull/7/head',
    });
  });

  it('returns null for non-positive numbers', () => {
    expect(parseGitHubPullRequestHeadRef(0)).toBeNull();
    expect(parseGitHubPullRequestHeadRef(-1)).toBeNull();
  });

  it('returns null for empty / blank input', () => {
    expect(parseGitHubPullRequestHeadRef('')).toBeNull();
    expect(parseGitHubPullRequestHeadRef('   ')).toBeNull();
    expect(parseGitHubPullRequestHeadRef(null)).toBeNull();
    expect(parseGitHubPullRequestHeadRef(undefined)).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(parseGitHubPullRequestHeadRef('abc')).toBeNull();
    expect(parseGitHubPullRequestHeadRef('1.5')).toBeNull();
  });

  it('returns null for values that exceed Number.MAX_SAFE_INTEGER', () => {
    // Number.MAX_SAFE_INTEGER + 1 loses precision; we treat it as null.
    expect(parseGitHubPullRequestHeadRef(`${Number.MAX_SAFE_INTEGER + 1}`)).toBeNull();
  });

  it('accepts large but safe integers', () => {
    // 1e10 is `10000000000` — fits in a safe integer, so it is parsed.
    // This matches the production behaviour in the web server.
    expect(parseGitHubPullRequestHeadRef('1e10')).toEqual({
      number: 10_000_000_000,
      sourceRef: 'refs/pull/10000000000/head',
    });
  });
});
