import { describe, expect, it } from 'vitest';
import { normalizeGitLabInstance } from './instance.js';

describe('normalizeGitLabInstance', () => {
  it('normalizes GitLab.com and self-managed origins', () => {
    expect(normalizeGitLabInstance('gitlab.com')).toBe('https://gitlab.com');
    expect(normalizeGitLabInstance('https://GitLab.Example.com:8443/')).toBe('https://gitlab.example.com:8443');
    expect(normalizeGitLabInstance('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('rejects insecure remote hosts and non-origin URLs', () => {
    expect(() => normalizeGitLabInstance('http://gitlab.example.com')).toThrow('must use HTTPS');
    expect(() => normalizeGitLabInstance('https://gitlab.example.com/group')).toThrow('must be an origin');
    expect(() => normalizeGitLabInstance('https://user:pass@gitlab.example.com')).toThrow('must be an origin');
  });
});
