import { describe, it, expect } from 'bun:test';
import { isPrivateBrowserHost, normalizeBrowserUrl } from './urls.js';

describe('normalizeBrowserUrl', () => {
  it('rejects empty and non-web schemes', () => {
    expect(normalizeBrowserUrl('').ok).toBe(false);
    expect(normalizeBrowserUrl('file:///etc/passwd').ok).toBe(false);
    expect(normalizeBrowserUrl('javascript:alert(1)').ok).toBe(false);
    expect(normalizeBrowserUrl('chrome://settings').ok).toBe(false);
    expect(normalizeBrowserUrl('data:text/html,<h1>x</h1>').ok).toBe(false);
  });

  it('passes about:blank through unchanged', () => {
    expect(normalizeBrowserUrl('about:blank')).toEqual({ ok: true, url: 'about:blank' });
  });

  it('adds http for private hosts and https for public hosts', () => {
    expect(normalizeBrowserUrl('localhost:3000').url).toBe('http://localhost:3000/');
    expect(normalizeBrowserUrl('example.com').url).toBe('https://example.com/');
  });

  it('resolves bare port shorthand against loopback', () => {
    expect(normalizeBrowserUrl(':5173/app').url).toBe('http://127.0.0.1:5173/app');
  });

  it('preserves explicit http and https URLs and flags private hosts', () => {
    const loopback = normalizeBrowserUrl('http://127.0.0.1:8080/health');
    expect(loopback.ok).toBe(true);
    expect(loopback.isPrivateHost).toBe(true);
    const remote = normalizeBrowserUrl('https://openchamber.dev/docs');
    expect(remote.ok).toBe(true);
    expect(remote.isPrivateHost).toBe(false);
  });

  it('rejects overly long input', () => {
    expect(normalizeBrowserUrl(`https://example.com/${'a'.repeat(5000)}`).ok).toBe(false);
  });
});

describe('isPrivateBrowserHost', () => {
  it('classifies loopback and private ranges as private', () => {
    expect(isPrivateBrowserHost('localhost')).toBe(true);
    expect(isPrivateBrowserHost('127.0.0.1')).toBe(true);
    expect(isPrivateBrowserHost('10.1.2.3')).toBe(true);
    expect(isPrivateBrowserHost('192.168.0.5')).toBe(true);
    expect(isPrivateBrowserHost('172.16.9.9')).toBe(true);
    expect(isPrivateBrowserHost('dev.local')).toBe(true);
  });

  it('classifies public hosts as not private', () => {
    expect(isPrivateBrowserHost('example.com')).toBe(false);
    expect(isPrivateBrowserHost('8.8.8.8')).toBe(false);
    expect(isPrivateBrowserHost('172.32.0.1')).toBe(false);
  });
});
