import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from '../git/loopback-http.js';
import { parseBindingResponse } from './binding-contract.js';

const bindingWith = (presentation) => ({
  repositoryId: 'repo_one', revision: 1, state: 'bound', configRevision: 'config', providers: [], auxiliary: [],
  remotes: [{
    name: 'origin',
    fetch: { displayUrl: 'https://example.com/team/repo.git', fingerprint: 'fetch' },
    push: { displayUrl: 'https://example.com/team/repo.git', fingerprint: 'push' },
    mode: 'managed', credentialId: 'credential-one', readiness: 'ready', presentation,
  }],
});
const httpsPresentation = (instance, username = 'alice') => ({
  status: 'available', transport: 'https', provider: 'gerrit', instance, source: 'pat', username, providerUserId: `${instance}#7`,
});
const accepts = (presentation) => {
  try {
    parseBindingResponse(bindingWith(presentation));
    return true;
  } catch {
    return false;
  }
};

describe('binding credential presentation', () => {
  it('takes every username sign-in takes, an LDAP-style one included', () => {
    expect(accepts(httpsPresentation('https://review.example.com', 'jane@corp.com'))).toBe(true);
    expect(accepts(httpsPresentation('https://review.example.com', 'first+tag'))).toBe(true);
    expect(accepts(httpsPresentation('https://review.example.com', 'jane:doe'))).toBe(false);
    expect(accepts(httpsPresentation('https://review.example.com', 'jane\u0085'))).toBe(false);
  });

  // The presentation inlines the loopback rule to stay dependency-free; it must be the transport's.
  it.each(['localhost', '127.0.0.1', '127.0.0.2', '127.255.255.254', '[::1]', 'example.com', '128.0.0.1', '10.0.0.1', '[::2]'])(
    'treats http://%s like the Git transport does',
    (host) => {
      expect(accepts(httpsPresentation(`http://${host}:8080`))).toBe(isLoopbackHost(new URL(`http://${host}`).hostname));
    },
  );
});
