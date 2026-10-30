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

describe('session events in the service grant', () => {
  const subscriber = (events, content) => ({
    service: guest.service,
    sessionEvents: content ? { events, content: true } : { events },
  });

  test('covers the events and whether their text comes along, and nothing for a service without them', () => {
    expect(guestGrantScope(subscriber(['question-asked', 'turn-finished'], true)).service).toEqual({
      exec: ['docker'], sockets: ['docker'], sessionEvents: { events: ['question-asked', 'turn-finished'], content: true },
    });
    expect(guestGrantScope(subscriber(['turn-finished'])).service.sessionEvents).toEqual({ events: ['turn-finished'], content: false });
    expect(guestGrantScope(guest).service).not.toHaveProperty('sessionEvents');
  });

  test('asks again when a version adds events or starts asking for their text', () => {
    const plain = guestGrantScope(guest);
    const one = guestGrantScope(subscriber(['turn-finished']));
    const two = guestGrantScope(subscriber(['turn-finished', 'turn-failed']));
    const withText = guestGrantScope(subscriber(['turn-finished'], true));
    expect(effectiveGrants(['service'], plain, one)).toEqual([]);
    expect(effectiveGrants(['service'], one, two)).toEqual([]);
    expect(effectiveGrants(['service'], one, withText)).toEqual([]);
    expect(effectiveGrants(['service'], one, one)).toEqual(['service']);
    // Dropping the subscription is a narrower package: it was approved for more.
    expect(effectiveGrants(['service'], one, plain)).toEqual([]);
  });

  test('transcript counts only while the approved subscription asked for the text the package asks for now', () => {
    const withText = guestGrantScope(subscriber(['turn-finished'], true));
    const moreWithText = guestGrantScope(subscriber(['turn-finished', 'question-asked'], true));
    const withoutText = guestGrantScope(subscriber(['turn-finished']));
    expect(effectiveGrants(['service', 'transcript'], withText, withText)).toEqual(['service', 'transcript']);
    expect(effectiveGrants(['service', 'transcript'], withText, moreWithText)).toEqual([]);
    expect(effectiveGrants(['service', 'transcript'], withoutText, withText)).toEqual([]);
    expect(effectiveGrants(['transcript'], undefined, withText)).toEqual([]);
    expect(effectiveGrants(['transcript'], guestGrantScope(guest), withText)).toEqual([]);
  });
});

describe('the notification channel role in the service grant', () => {
  const channel = (instances) => ({
    service: { ...guest.service, provides: ['notifications'] },
    notifications: { label: 'Slack', instances, token: { header: 'authorization', scheme: 'bearer' } },
  });

  test('covers where the account lives, and nothing for a service without the role', () => {
    expect(guestGrantScope(channel({ kind: 'fixed', origin: 'https://slack.com' })).service.notifications).toEqual({ kind: 'fixed', origin: 'https://slack.com' });
    expect(guestGrantScope(channel({ kind: 'user', label: 'Homeserver' })).service.notifications).toEqual({ kind: 'user' });
    expect(guestGrantScope(guest).service).not.toHaveProperty('notifications');
  });

  test('asks again when a version adds the role or moves the server its account lives on', () => {
    const plain = guestGrantScope(guest);
    const slack = guestGrantScope(channel({ kind: 'fixed', origin: 'https://slack.com' }));
    expect(effectiveGrants(['service'], plain, slack)).toEqual([]);
    expect(effectiveGrants(['service'], slack, guestGrantScope(channel({ kind: 'fixed', origin: 'https://evil.example' })))).toEqual([]);
    expect(effectiveGrants(['service'], slack, guestGrantScope(channel({ kind: 'user', label: 'Server' })))).toEqual([]);
    expect(effectiveGrants(['service'], slack, slack)).toEqual(['service']);
    expect(effectiveGrants(['service'], slack, plain)).toEqual([]);
  });
});
