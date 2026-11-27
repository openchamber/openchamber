import { describe, expect, it } from 'vitest';
import { normalizeGitLabInstance } from './instance.js';

describe('normalizeGitLabInstance', () => {
  it('normalizes GitLab.com and self-managed origins', () => {
    expect(normalizeGitLabInstance('gitlab.com')).toBe('https://gitlab.com');
    expect(normalizeGitLabInstance('https://GitLab.Example.com:8443/')).toBe('https://gitlab.example.com:8443');
    expect(normalizeGitLabInstance('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeGitLabInstance('http://10.0.0.5')).toBe('http://10.0.0.5');
    expect(normalizeGitLabInstance('http://192.168.1.10:8080/')).toBe('http://192.168.1.10:8080');
    expect(normalizeGitLabInstance('http://172.16.0.2')).toBe('http://172.16.0.2');
    expect(normalizeGitLabInstance('http://169.254.10.20')).toBe('http://169.254.10.20');
  });

  it('rejects insecure remote hosts and non-origin URLs', () => {
    expect(() => normalizeGitLabInstance('http://gitlab.example.com')).toThrow('must use HTTPS');
    expect(() => normalizeGitLabInstance('http://93.184.216.34')).toThrow('must use HTTPS');
    expect(() => normalizeGitLabInstance('http://172.32.0.2')).toThrow('must use HTTPS');
    expect(() => normalizeGitLabInstance('https://gitlab.example.com/group')).toThrow('must be an origin');
    expect(() => normalizeGitLabInstance('https://user:pass@gitlab.example.com')).toThrow('must be an origin');
  });
});
