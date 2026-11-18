import { expect, it } from 'vitest';
import { createHostFixture } from './host-test-support.js';

it('creates and replaces OAuth identities over HTTP without returning or reusing their secrets', async () => {
  // Given the production authenticated-route composition and an OAuth identity definition.
  const f = await createHostFixture();
  try {
    const definition = { kind: 'jira-oauth', label: 'PiggyOps', site: 'https://fixture.atlassian.net',
      cloudId: 'd313a597-a578-4b2e-bf98-93308087542e', clientId: 'controlled-client', clientSecret: 'controlled-original' };
    // When the identity is created and later explicitly replaced through the public routes.
    const created = await f.request('/identities', 'POST', definition);
    expect(created.status).toBe(200);
    const replaced = await f.request(`/identities/${created.body.identity.id}`, 'PUT', {
      expectedRevision: 1, definition: { ...definition, clientSecret: 'controlled-replacement' },
    });
    // Then metadata round-trips, secret-bearing fields never return, and stale replacements fail.
    expect(replaced.status).toBe(200);
    expect(replaced.body.identity).toMatchObject({ kind: 'jira-oauth', revision: 2, cloudId: definition.cloudId, clientId: definition.clientId });
    const listed = await f.request('/identities');
    expect(listed.body.identities).toEqual([replaced.body.identity]);
    expect(JSON.stringify([created.body, replaced.body, listed.body])).not.toMatch(/clientSecret|controlled-original|controlled-replacement|access_token/);
    const stale = await f.request(`/identities/${created.body.identity.id}`, 'PUT', { expectedRevision: 1, definition });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
    expect(f.calls.http).toEqual([]);
  } finally { await f.close(); }
});
