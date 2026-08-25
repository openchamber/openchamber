import { describe, expect, test } from 'bun:test';
import { parseGitHost } from './gitHost';

describe('parseGitHost', () => {
  test('scp-like form with user', () => {
    expect(parseGitHost('git@codeberg.org:owner/repo.git')).toBe('codeberg.org');
    expect(parseGitHost('git@git.example.com:group/repo.git')).toBe('git.example.com');
  });

  test('scp-like form without user (bare host:path)', () => {
    expect(parseGitHost('codeberg.org:owner/repo.git')).toBe('codeberg.org');
    expect(parseGitHost('git.example.com:group/repo.git')).toBe('git.example.com');
  });

  test('ssh URL with port', () => {
    expect(parseGitHost('ssh://git@codeberg.org:2222/owner/repo.git')).toBe('codeberg.org');
  });

  test('git+ssh and git schemes', () => {
    expect(parseGitHost('git+ssh://git@host/owner/repo.git')).toBe('host');
    expect(parseGitHost('git://host/owner/repo.git')).toBe('host');
  });

  test('https with user and port', () => {
    expect(parseGitHost('https://user@host:8443/owner/repo.git')).toBe('host');
  });

  test('IPv6 URL form returns the bare address', () => {
    expect(parseGitHost('ssh://git@[2001:db8::1]/owner/repo.git')).toBe('2001:db8::1');
    expect(parseGitHost('ssh://git@[2001:DB8::1]:2222/owner/repo.git')).toBe('2001:db8::1');
  });

  test('bracketed IPv6 input', () => {
    expect(parseGitHost('[2001:db8::1]')).toBe('2001:db8::1');
    expect(parseGitHost('[2001:db8::1]:owner/repo.git')).toBe('2001:db8::1');
  });

  test('unbracketed IPv6 input', () => {
    expect(parseGitHost('2001:db8::1')).toBe('2001:db8::1');
  });

  test('plain hostname and hostname-with-user without a colon', () => {
    expect(parseGitHost('git.example.com')).toBe('git.example.com');
    expect(parseGitHost('git@host')).toBe('host');
  });

  test('hostname with trailing dot is stripped once', () => {
    expect(parseGitHost('git.example.com.')).toBe('git.example.com');
    expect(parseGitHost('ssh://git.example.com./owner/repo.git')).toBe('git.example.com');
  });

  test('input is trimmed', () => {
    expect(parseGitHost('  codeberg.org:owner/repo.git  ')).toBe('codeberg.org');
    expect(parseGitHost(' ssh://git@codeberg.org/owner/repo.git ')).toBe('codeberg.org');
  });

  test('empty, whitespace, and null input', () => {
    expect(parseGitHost('')).toBeNull();
    expect(parseGitHost('   ')).toBeNull();
    expect(parseGitHost(' \t ')).toBeNull();
    expect(parseGitHost(null as unknown as string)).toBeNull();
  });

  test('garbage input', () => {
    expect(parseGitHost('not a url')).toBeNull();
    expect(parseGitHost('ssh://not a url')).toBeNull();
  });

  test('Windows-path-like input is not a host', () => {
    expect(parseGitHost('C:\\foo')).toBeNull();
    expect(parseGitHost('C:\\foo\\bar.git')).toBeNull();
  });
});
