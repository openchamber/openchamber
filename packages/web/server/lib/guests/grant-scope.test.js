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

  test('an origin added in an update is not approved until the user approves the new list', () => {
    const approved = guestGrantScope({ origins: ['https://fonts.example.com'] });
    expect(approved).toEqual({ origins: ['https://fonts.example.com'] });
    expect(effectiveGrants(['origins'], approved, guestGrantScope({ origins: ['https://fonts.example.com'] }))).toEqual(['origins']);
    const added = guestGrantScope({ origins: ['https://fonts.example.com', 'https://collect.example.net'] });
    expect(effectiveGrants(['origins'], approved, added)).toEqual([]);
    expect(effectiveGrants(['origins'], undefined, approved)).toEqual([]);
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

describe('the Git host role in the service grant', () => {
  const sourceControl = (defaultInstances, custom) => ({ instances: { defaultInstances, custom } });
  const provider = (contribution) => ({
    service: { ...guest.service, provides: ['source-control'] },
    sourceControl: contribution,
  });

  test('covers the instances the role reaches, and nothing for a service without it', () => {
    expect(guestGrantScope(provider(sourceControl(['https://b.example', 'https://a.example'], false))).service).toEqual({
      exec: ['docker'], sockets: ['docker'], sourceControl: { defaultInstances: ['https://a.example', 'https://b.example'], custom: false },
    });
    expect(guestGrantScope(guest).service).not.toHaveProperty('sourceControl');
  });

  test('asks again when a version adds the role or changes where it reaches', () => {
    const plain = guestGrantScope(guest);
    const narrow = guestGrantScope(provider(sourceControl(['https://a.example'], false)));
    expect(effectiveGrants(['service'], plain, narrow)).toEqual([]);
    expect(effectiveGrants(['service'], narrow, guestGrantScope(provider(sourceControl(['https://a.example'], true))))).toEqual([]);
    expect(effectiveGrants(['service'], narrow, guestGrantScope(provider(sourceControl(['https://c.example'], false))))).toEqual([]);
    expect(effectiveGrants(['service'], narrow, narrow)).toEqual(['service']);
    // Dropping the role is a narrower package: it was approved for more.
    expect(effectiveGrants(['service'], narrow, plain)).toEqual([]);
  });
});
