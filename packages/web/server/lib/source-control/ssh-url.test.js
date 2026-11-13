import { describe, expect, it } from 'vitest';
import { normalizeSshUrl, parseSshUrl, sshHostMatches } from './ssh-url.js';

describe('provider SSH addresses', () => {
  it.each([
    ['ssh://git@gitea.example.com:2222', { host: 'gitea.example.com', port: 2222 }],
    ['ssh://gitea.example.com', { host: 'gitea.example.com', port: 22 }],
    ['git@gitea.example.com:2222', { host: 'gitea.example.com', port: 2222 }],
    ['gitea.example.com', { host: 'gitea.example.com', port: 22 }],
    ['gitea.example.com:2200', { host: 'gitea.example.com', port: 2200 }],
    ['ssh://[::1]:2222', { host: '[::1]', port: 2222 }],
  ])('parses %s', (value, expected) => {
    expect(parseSshUrl(value)).toEqual(expected);
  });

  it.each(['http://gitea.example.com', 'git+ssh://gitea.example.com', 'ssh://gitea.example.com/owner/repo', 'git@gitea.example.com:owner/repo.git', 'gitea.example.com:0', 'gitea.example.com:70000', 'not a host'])('does not parse %s', (value) => {
    expect(parseSshUrl(value)).toBeNull();
  });

  it('stores one canonical address without the username or the default port', () => {
    expect(normalizeSshUrl('git@gitea.example.com:2222')).toBe('ssh://gitea.example.com:2222');
    expect(normalizeSshUrl('ssh://gitea.example.com:22')).toBe('ssh://gitea.example.com');
    expect(normalizeSshUrl('')).toBeNull();
    expect(() => normalizeSshUrl('https://gitea.example.com')).toThrow(/SSH URL/);
  });

  it('matches a remote host and port to the configured address', () => {
    expect(sshHostMatches('ssh://gitea.example.com:2222', 'gitea.example.com', 2222)).toBe(true);
    expect(sshHostMatches('ssh://gitea.example.com', 'gitea.example.com', 22)).toBe(true);
    expect(sshHostMatches('ssh://gitea.example.com:2222', 'gitea.example.com', 22)).toBe(false);
    expect(sshHostMatches('ssh://gitea.example.com', 'elsewhere.example.com', 22)).toBe(false);
  });
});
