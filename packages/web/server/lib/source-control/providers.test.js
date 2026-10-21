import { describe, expect, it } from 'vitest';
import {
  SOURCE_CONTROL_PROVIDERS,
  isSourceControlProvider,
  matchesProviderUserId,
  normalizeSourceControlProviderInstance,
  providerCredentialSecret,
  providerCredentialUsername,
  providerOrigin,
  providerTraits,
  providerUserIdFor,
} from './providers.js';

describe('source-control provider registry', () => {
  it('names every provider in one place', () => {
    expect(SOURCE_CONTROL_PROVIDERS).toEqual(['github', 'gitlab', 'gitea']);
    expect(isSourceControlProvider('gitea')).toBe(true);
    expect(isSourceControlProvider('bitbucket')).toBe(false);
  });

  it('normalizes each provider instance to an origin', () => {
    expect(normalizeSourceControlProviderInstance('github', 'https://github.com/')).toBe('github.com');
    expect(normalizeSourceControlProviderInstance('gitlab', 'gitlab.example.com')).toBe('https://gitlab.example.com');
    expect(normalizeSourceControlProviderInstance('gitea', 'http://localhost:3000/')).toBe('http://localhost:3000');
    expect(() => normalizeSourceControlProviderInstance('gitea', 'https://gitea.example.com/subpath')).toThrow();
    expect(() => normalizeSourceControlProviderInstance('gitea', 'http://gitea.example.com')).toThrow();
  });

  it('builds origins and stable provider user identities', () => {
    expect(providerOrigin('gitea', 'https://gitea.example.com').origin).toBe('https://gitea.example.com');
    expect(providerOrigin('github', 'github.com').origin).toBe('https://github.com');
    expect(providerUserIdFor('gitea', 'https://gitea.example.com', { id: 7 })).toBe('https://gitea.example.com#7');
    expect(matchesProviderUserId('gitea', 'https://gitea.example.com', 'https://gitea.example.com#7')).toBe(true);
    expect(matchesProviderUserId('gitea', 'https://gitea.example.com', 'github.com#7')).toBe(false);
    expect(matchesProviderUserId('github', 'github.com', 'github.com#7')).toBe(true);
  });

  it('keeps provider credential shapes distinct', () => {
    expect(providerCredentialSecret('github', { accessToken: 'a' })).toBe('a');
    expect(providerCredentialSecret('gitea', { token: 't' })).toBe('t');
    expect(providerCredentialUsername('github')).toBe('x-access-token');
    expect(providerCredentialUsername('gitlab')).toBe('oauth2');
    expect(providerCredentialUsername('gitea', { user: { login: 'ada' } })).toBe('ada');
  });

  it('refuses a provider it has no traits for', () => {
    expect(() => providerTraits('bitbucket')).toThrow('unsupported');
  });
});
