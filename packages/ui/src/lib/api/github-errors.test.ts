import { describe, expect, test } from 'bun:test';
import { getGitHubApiErrorCode, parseGitHubApiErrorCode } from './github-errors';

describe('parseGitHubApiErrorCode', () => {
  test('accepts only the known failure codes', () => {
    expect(parseGitHubApiErrorCode('search_timeout')).toBe('search_timeout');
    expect(parseGitHubApiErrorCode('not_found')).toBe('not_found');
    expect(parseGitHubApiErrorCode('repo_unavailable')).toBe('repo_unavailable');
  });

  test('rejects every other value', () => {
    expect(parseGitHubApiErrorCode('other')).toBeNull();
    expect(parseGitHubApiErrorCode(undefined)).toBeNull();
    expect(parseGitHubApiErrorCode(null)).toBeNull();
    expect(parseGitHubApiErrorCode(404)).toBeNull();
  });
});

describe('getGitHubApiErrorCode', () => {
  test('reads a known code from an error', () => {
    const error = Object.assign(new Error('Search timed out'), { code: 'search_timeout' });
    expect(getGitHubApiErrorCode(error)).toBe('search_timeout');
  });

  test('returns null for an unknown code', () => {
    const error = Object.assign(new Error('Nope'), { code: 'something_else' });
    expect(getGitHubApiErrorCode(error)).toBeNull();
  });

  test('returns null for an error without a code and for non-errors', () => {
    expect(getGitHubApiErrorCode(new Error('plain'))).toBeNull();
    expect(getGitHubApiErrorCode({ code: 'not_found' })).toBeNull();
    expect(getGitHubApiErrorCode(null)).toBeNull();
    expect(getGitHubApiErrorCode('search_timeout')).toBeNull();
  });
});
