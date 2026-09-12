import { describe, expect, it } from 'vitest';
import { parseGitHubReference } from './reference.js';

describe('parseGitHubReference', () => {
  it('accepts a bare number or #number as an untyped reference', () => {
    expect(parseGitHubReference('123')).toEqual({ kind: null, number: 123 });
    expect(parseGitHubReference(' #123 ')).toEqual({ kind: null, number: 123 });
    expect(parseGitHubReference('42')).toEqual({ kind: null, number: 42 });
  });

  it('accepts github.com issue and pull URLs with a known kind, owner, and repo', () => {
    expect(parseGitHubReference('https://github.com/acme/app/issues/123')).toEqual({
      kind: 'issue',
      number: 123,
      owner: 'acme',
      repo: 'app',
    });
    expect(parseGitHubReference('https://www.github.com/acme/app/pull/456')).toEqual({
      kind: 'pr',
      number: 456,
      owner: 'acme',
      repo: 'app',
    });
  });

  it('accepts trailing path segments, fragments, and query strings', () => {
    expect(parseGitHubReference('https://github.com/acme/app/pull/456/files')).toEqual({
      kind: 'pr',
      number: 456,
      owner: 'acme',
      repo: 'app',
    });
    expect(parseGitHubReference('https://github.com/acme/app/issues/123#issuecomment-456')).toEqual({
      kind: 'issue',
      number: 123,
      owner: 'acme',
      repo: 'app',
    });
    expect(parseGitHubReference('https://github.com/acme/app/issues/123?notification_referrer_id=1')).toEqual({
      kind: 'issue',
      number: 123,
      owner: 'acme',
      repo: 'app',
    });
    expect(parseGitHubReference('https://github.com/acme/app/pull/456/')).toEqual({
      kind: 'pr',
      number: 456,
      owner: 'acme',
      repo: 'app',
    });
  });

  it('accepts scheme-less github.com and www.github.com URLs', () => {
    expect(parseGitHubReference('github.com/acme/app/issues/7')).toEqual({
      kind: 'issue',
      number: 7,
      owner: 'acme',
      repo: 'app',
    });
    expect(parseGitHubReference('www.github.com/acme/app/pull/8')).toEqual({
      kind: 'pr',
      number: 8,
      owner: 'acme',
      repo: 'app',
    });
  });

  it('rejects foreign hosts, including host names that merely contain github.com', () => {
    expect(parseGitHubReference('https://gitlab.com/acme/app/issues/1')).toBeNull();
    expect(parseGitHubReference('https://github.com.evil.example/acme/app/issues/1')).toBeNull();
    expect(parseGitHubReference('https://notgithub.com/acme/app/pull/1')).toBeNull();
  });

  it('rejects non-GitHub strings that contain an issue or pull path', () => {
    expect(parseGitHubReference('notgithub.com/acme/app/issues/1')).toBeNull();
    expect(parseGitHubReference('/acme/app/issues/1')).toBeNull();
    expect(parseGitHubReference('example.com/acme/app/pull/2')).toBeNull();
  });

  it('rejects free text, mixed text+number, and URLs without a valid item path', () => {
    expect(parseGitHubReference('123 bug')).toBeNull();
    expect(parseGitHubReference('bug 123')).toBeNull();
    expect(parseGitHubReference('search query')).toBeNull();
    expect(parseGitHubReference('')).toBeNull();
    expect(parseGitHubReference('   ')).toBeNull();
    expect(parseGitHubReference('https://github.com/acme/app')).toBeNull();
    expect(parseGitHubReference('https://github.com/acme/app/issues')).toBeNull();
    expect(parseGitHubReference('https://github.com/acme/app/issues/')).toBeNull();
    expect(parseGitHubReference('https://github.com/acme/app/issues/123abc')).toBeNull();
    expect(parseGitHubReference('https://github.com/issues/123')).toBeNull();
  });

  it('rejects zero and negative numbers', () => {
    expect(parseGitHubReference('0')).toBeNull();
    expect(parseGitHubReference('#0')).toBeNull();
    expect(parseGitHubReference('-5')).toBeNull();
    expect(parseGitHubReference('https://github.com/acme/app/issues/0')).toBeNull();
    expect(parseGitHubReference('https://github.com/acme/app/pull/0')).toBeNull();
  });
});
