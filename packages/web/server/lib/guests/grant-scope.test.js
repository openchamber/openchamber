import { describe, expect, test } from 'bun:test';

import { effectiveGrants, guestGrantScope, sameCredentialTarget } from './grant-scope.js';

const guest = {
  filesystem: ['~/notes/**', '~/.config/opencode/opencode.json'],
  integration: {
    name: 'Acme',
    description: 'Tasks',
    token: { apiOrigin: 'https://api.acme.example' },
  },
  service: {
    entry: 'service/main.js',
    runtime: 'host',
    permissions: { exec: ['docker'], sockets: [{ id: 'docker', candidatesByPlatform: {} }] },
  },
};

describe('guestGrantScope', () => {
  test('captures sorted patterns, the API origin, and service permissions', () => {
    expect(guestGrantScope(guest)).toEqual({
      filesystem: ['~/.config/opencode/opencode.json', '~/notes/**'],
      apiOrigin: 'https://api.acme.example',
      service: { exec: ['docker'], sockets: ['docker'] },
    });
    expect(guestGrantScope({})).toEqual({});
    expect(guestGrantScope({ integration: { name: 'L', description: 'x', host: { provider: 'linear' } } }))
      .toEqual({ apiOrigin: 'https://api.linear.app' });
  });
});

describe('effectiveGrants', () => {
  const granted = ['prompt', 'filesystem', 'network', 'service'];

  test('keeps every grant while the scope is what the user approved', () => {
    const scope = guestGrantScope(guest);
    expect(effectiveGrants(granted, scope, scope)).toEqual(granted);
  });

  test('drops a scoped grant when the package widened it', () => {
    const approved = guestGrantScope(guest);
    const wider = guestGrantScope({ ...guest, filesystem: ['~/**'] });
    expect(effectiveGrants(granted, approved, wider)).toEqual(['prompt', 'network', 'service']);
    const moved = guestGrantScope({ ...guest, integration: { ...guest.integration, token: { apiOrigin: 'https://evil.example' } } });
    expect(effectiveGrants(granted, approved, moved)).toEqual(['prompt', 'filesystem', 'service']);
    const moreExec = guestGrantScope({ ...guest, service: { ...guest.service, permissions: { exec: ['docker', 'kubectl'], sockets: guest.service.permissions.sockets } } });
    expect(effectiveGrants(granted, approved, moreExec)).toEqual(['prompt', 'filesystem', 'network']);
  });

  test('never counts a scoped grant without a recorded scope', () => {
    expect(effectiveGrants(granted, undefined, guestGrantScope(guest))).toEqual(['prompt']);
  });
});

describe('oauth endpoints', () => {
  const oauthGuest = {
    integration: {
      name: 'Acme',
      description: 'Tasks',
      oauth: { authorizeUrl: 'https://acme.example/authorize', tokenUrl: 'https://acme.example/token', apiOrigin: 'https://api.acme.example' },
    },
  };

  test('a moved token endpoint drops the network grant and the credentials', () => {
    const approved = guestGrantScope(oauthGuest);
    expect(approved).toEqual({
      apiOrigin: 'https://api.acme.example',
      oauth: { authorizeUrl: 'https://acme.example/authorize', tokenUrl: 'https://acme.example/token' },
    });
    const moved = guestGrantScope({ integration: { ...oauthGuest.integration, oauth: { ...oauthGuest.integration.oauth, tokenUrl: 'https://evil.example/token' } } });
    expect(effectiveGrants(['network'], approved, moved)).toEqual([]);
    expect(sameCredentialTarget(approved, moved)).toBe(false);
    expect(sameCredentialTarget(approved, guestGrantScope(oauthGuest))).toBe(true);
  });
});
