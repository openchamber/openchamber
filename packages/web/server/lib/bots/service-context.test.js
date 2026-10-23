import { afterEach, expect, test } from 'bun:test';
import { createBotServiceContext } from './service-context.js';
import { productionFixture } from './production-test-support.js';

let fixture;
afterEach(async () => { await fixture?.close(); fixture = null; });

test('service context resolves the chosen account and rejects ambiguous or absent identities', async () => {
  const f = fixture = await productionFixture();
  const request = { ...f.request, service: 'github', operation: 'pr.open' };
  const context = await f.context.serviceContext(request);
  expect(context.github.identityId).toBe((await f.identities.list())[0].id);
  expect(context.github.target).toMatchObject({ owner: 'acme', repo: 'app' });
  await f.identities.create({ kind: 'github-account', accountId: 'selected-account', credentialRevision: 1, label: 'Duplicate' });
  await expect(f.context.serviceContext(request)).rejects.toMatchObject({ code: 'BOT_IDENTITY_REQUIRED' });
});

test('Jira done status comes from the configured transition, and Discord needs captured server routing', async () => {
  const f = fixture = await productionFixture();
  const identity = await f.identities.create({ kind: 'jira-service', site: 'https://acme.atlassian.net', email: 'bot@example.test', apiToken: 'fixture-token', label: 'Jira' });
  const reads = [];
  const context = createBotServiceContext({ identities: f.identities, services: { read: async (request) => {
    reads.push(request);
    return [{ id: '5', to: { id: '9' } }];
  } } });
  const bot = { ...f.bot, identity: { jira: { identityId: identity.id } }, jira: { doneTransition: '5' } };
  const result = await context.serviceContext({ ...f.request, bot, item: { ...f.item, source: { kind: 'jira', id: 'ACME-42' } }, service: 'jira', operation: 'jira.transition' });
  expect(result.jira).toEqual({ identityId: identity.id, identityRevision: 1, target: { issueKey: 'ACME-42', projectKey: 'ACME' }, expectedStatusId: '9' });
  expect(reads[0].operation).toBe('jira.transitions');
  await expect(context.serviceContext({ ...f.request, bot: { identity: { discord: { identityId: 'missing' } } }, service: 'discord', operation: 'discord.send' }))
    .rejects.toMatchObject({ code: 'BOT_DISCORD_DESTINATION_REQUIRED' });
});

test('requested GitHub and ordinary Jira contexts ignore unrelated Discord routing and done transitions', async () => {
  const f = fixture = await productionFixture();
  const identity = await f.identities.create({ kind: 'jira-service', site: 'https://acme.atlassian.net', email: 'bot@example.test', apiToken: 'fixture-token', label: 'Jira' });
  let transitionReads = 0;
  let discordResolutions = 0;
  const context = createBotServiceContext({ identities: f.identities,
    fetchImpl: async () => new Response(JSON.stringify({ id: 42, login: 'selected-bot' }), { headers: { 'content-type': 'application/json' } }),
    services: { read: async () => { transitionReads++; return []; } },
    resolveDiscordTarget: async () => { discordResolutions++; throw Object.assign(new Error('Ambiguous Discord target'), { code: 'BOT_DISCORD_DESTINATION_AMBIGUOUS' }); },
  });
  const request = { ...f.request, bot: { ...f.bot,
    identity: { ...f.bot.identity, jira: { identityId: identity.id }, discord: { identityId: 'unavailable-discord' } },
    jira: { doneTransition: '5' },
  }, item: { ...f.item, source: { kind: 'jira', id: 'ACME-42' } } };
  const github = await context.serviceContext({ ...request, service: 'github', operation: 'pr.open' });
  expect(Object.keys(github)).toEqual(['github']);
  expect(github.github.target).toMatchObject({ owner: 'acme', repo: 'app' });
  for (const operation of ['jira.issue', 'jira.comments', 'jira.comment']) {
    const result = await context.serviceContext({ ...request, service: 'jira', operation });
    expect(result).toEqual({ jira: { identityId: identity.id, identityRevision: 1, target: { issueKey: 'ACME-42', projectKey: 'ACME' } } });
  }
  expect(transitionReads).toBe(0);
  expect(discordResolutions).toBe(0);
  await expect(context.serviceContext({ ...request, service: 'jira', operation: 'jira.transition' })).rejects.toMatchObject({ code: 'BOT_JIRA_TRANSITION_UNAVAILABLE' });
  expect(transitionReads).toBe(1);
  await expect(context.serviceContext({ ...request, service: 'github', operation: 'jira.transition' })).rejects.toThrow();
});
