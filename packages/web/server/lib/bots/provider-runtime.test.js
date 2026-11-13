import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createBotProviderRuntime } from './provider-runtime.js';
import { createBotDriver } from './runtime-test-support.js';
import { BotServiceError } from './services/contracts.js';
import { readRepositoryPolicy } from './repository-policy.js';
import { createBotServiceContext } from './service-context.js';

const roots = []; const runtimes = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const setup = async (options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-provider-runtime-')); roots.push(root);
  const driver = await createBotDriver(root, { held: ['investigation'], bot: { identity: { jira: { identityId: 'jira-id' }, discord: { identityId: 'discord-id' } }, discord: { channels: [{ guildId: '111111', channelId: '222222' }] } } });
  const calls = []; const gateways = []; const attention = []; let unavailable = false;
  const services = { read: async (request) => {
    calls.push(request);
    if (unavailable) throw new BotServiceError('BOT_SERVICE_AUTH_REQUIRED', 'Authorize Jira.');
    return { total: 1, nextStartAt: null, comments: [{ id: 'comment', authorId: 'person', human: true, body: 'More evidence', createdAt: '2026-10-22T01:00:00Z' }] };
  } };
  const runtime = createBotProviderRuntime({ dataDir: root, config: driver.config, store: driver.store, runtime: driver.runtime,
    identities: { list: async () => [{ id: 'jira-id', revision: 3, kind: 'jira-account', site: 'https://team.atlassian.net' }, { id: 'discord-id', revision: 2, kind: 'discord-app' }] },
    services, listProjects: async () => [driver.project], resolveProject: async () => driver.project,
    serviceContext: async ({ item }) => ({ jira: { identityId: 'jira-id', identityRevision: 3, target: { projectKey: 'TEST', issueKey: item.source.id } } }),
    onNeedsYou: async (value) => attention.push(value),
    createGateway: (value) => { const gateway = { ...value, start: async () => {}, stop: async () => { gateway.stopped = true; }, halted: () => false }; gateways.push(gateway); return gateway; }, ...options,
  });
  runtimes.push(runtime);
  return { root, driver, runtime, calls, gateways, attention, fail: () => { unavailable = true; } };
};

it('polls only active Jira item issues with the selected revision and delivers through the real engine', async () => {
  const fixture = await setup();
  const item = await fixture.driver.admit({ kind: 'jira', id: 'TEST-7' });
  await fixture.runtime.start();
  await fixture.runtime.tick();
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls[0]).toMatchObject({ identityId: 'jira-id', identityRevision: 3, operation: 'jira.comments', target: { issueKey: 'TEST-7' } });
  expect(fixture.driver.calls.notices).toHaveLength(1);
  expect(fixture.driver.calls.notices[0]).toMatchObject({ item: { id: item.id }, eventId: 'jira:TEST-7:comment' });
  expect(await fixture.runtime.resolveJiraContext({ project: fixture.driver.project, bot: (await fixture.driver.config.read('project')).definitions[0] })).toEqual({ identityId: 'jira-id', identityRevision: 3, site: 'https://team.atlassian.net' });
});

it('polls Jira through its scoped context despite unavailable Done and ambiguous Discord destinations', async () => {
  const identities = {
    list: async () => [{ id: 'jira-id', revision: 3, kind: 'jira-service' }, { id: 'discord-id', revision: 2, kind: 'discord-app' }],
    resolve: async (id, revision) => ({ id, revision, definition: { kind: 'jira-service' } }),
  };
  const context = createBotServiceContext({ identities,
    services: { read: async () => { throw new Error('Done transition is unavailable'); } },
    resolveDiscordTarget: async () => { throw new Error('Discord target is ambiguous'); },
  });
  const fixture = await setup({ serviceContext: (request) => {
    expect(request).toMatchObject({ service: 'jira', operation: 'jira.comments' });
    return context.serviceContext({ ...request, bot: { ...request.bot, jira: { doneTransition: '31' } } });
  } });
  await fixture.driver.admit({ kind: 'jira', id: 'TEST-7' });
  const started = await fixture.runtime.start();
  expect(started.failures).toEqual([]);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0].operation).toBe('jira.comments');
  expect(fixture.driver.calls.notices).toHaveLength(1);
});

it('reports authorization as needs-you and leaves the source cursor undelivered until reconfigured', async () => {
  const fixture = await setup(); await fixture.driver.admit({ kind: 'jira', id: 'TEST-7' }); fixture.fail();
  await fixture.runtime.start(); await fixture.runtime.tick();
  expect(fixture.attention[0]).toMatchObject({ state: 'needs-you', reason: 'BOT_SERVICE_AUTH_REQUIRED', projectId: 'project' });
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.driver.calls.notices).toEqual([]);
  await fixture.runtime.reconfigure(); await fixture.runtime.tick();
  expect(fixture.calls).toHaveLength(2);
});

it('continues a waiting Jira item after a human reply and keeps delivery deduplicated', async () => {
  // Given an investigation has asked a question and correction remains pending.
  const fixture = await setup();
  const item = await fixture.driver.admit({ kind: 'jira', id: 'TEST-7' });
  fixture.driver.controls.questions = ['Which behavior is intended?'];
  fixture.driver.held.add('fixing');
  await fixture.driver.runtime.pump('project');
  fixture.driver.complete('investigation');
  await fixture.driver.runtime.pump('project');
  expect((await fixture.driver.runtime.detail('project', item.id)).item.state).toBe('waiting-answer');
  // When the provider delivers the human comment and subsequently polls it again.
  await fixture.runtime.start();
  await fixture.runtime.tick();
  // Then the owner resumes correction once and retains one notice for the reply.
  expect((await fixture.driver.runtime.detail('project', item.id)).item.state).toBe('fixing');
  expect(fixture.driver.calls.notices).toHaveLength(1);
});

it('links configured-channel Discord messages to admitted items and resumes deduplicated feedback', async () => {
  const fixture = await setup(); await fixture.runtime.start();
  const event = { id: 'discord:333333', identityId: 'discord-id', provider: 'discord', channelId: '222222', guildId: '111111', authorId: '444444', body: 'Investigate this defect' };
  await fixture.gateways[0].deliver(event);
  const items = (await fixture.driver.store.read('project')).items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ source: { kind: 'alert', id: 'discord:333333' } });
  const bot = (await fixture.driver.config.read('project')).definitions[0];
  expect(await fixture.runtime.resolveDiscordTarget({ project: fixture.driver.project, bot, item: items[0] })).toEqual({ guildId: '111111', channelId: '222222' });
  await fixture.gateways[0].deliver({ ...event, id: 'discord:555555', threadId: '333333', body: 'A reply' });
  await fixture.gateways[0].deliver({ ...event, id: 'discord:555555', threadId: '333333', body: 'A reply' });
  expect(fixture.driver.calls.notices).toHaveLength(1);
  expect((await fixture.driver.store.read('project')).items).toHaveLength(1);
  await expect(fixture.gateways[0].deliver({ ...event, guildId: 'dm' })).rejects.toMatchObject({ code: 'BOT_EVENT_NOT_AUTHORIZED' });
  await fixture.runtime.stop();
  expect(fixture.gateways[0].stopped).toBe(true);
});

it('resumes a waiting Discord conversation through the answer owner', async () => {
  // Given a configured conversation whose investigation asks for clarification.
  const fixture = await setup();
  fixture.driver.controls.questions = ['Which behavior is intended?'];
  fixture.driver.held.delete('investigation');
  fixture.driver.held.add('fixing');
  await fixture.runtime.start();
  const event = { id: 'discord:333333', provider: 'discord', channelId: '222222', guildId: '111111', authorId: '444444', body: 'Investigate this defect' };
  await fixture.gateways[0].deliver(event);
  const [item] = (await fixture.driver.store.read('project')).items;
  expect(item.state).toBe('waiting-answer');
  // When that authorized conversation receives a reply.
  await fixture.gateways[0].deliver({ ...event, id: 'discord:555555', threadId: '333333', body: 'Use the documented behavior' });
  // Then the same item continues correction and the answer is retained once.
  expect((await fixture.driver.runtime.detail('project', item.id)).item.state).toBe('fixing');
  expect(fixture.driver.calls.notices).toHaveLength(1);
});

it('admits DMs only through the currently approved people file and reconfigures the Gateway', async () => {
  const fixture = await setup(); await fixture.runtime.start();
  await fs.mkdir(path.join(fixture.root, '.openchamber'));
  await fs.writeFile(path.join(fixture.root, '.openchamber/people.json'), JSON.stringify([{ id: 'person', name: 'Reviewer', roles: [], discord: '444444' }]));
  const policy = await readRepositoryPolicy(fixture.root);
  await fixture.driver.config.setApproval('project', '.openchamber/people.json', policy.people.fingerprint);
  await fixture.runtime.reconfigure();
  expect(fixture.gateways[0].stopped).toBe(true);
  expect(fixture.gateways[1].people).toEqual(['444444']);
  const event = { id: 'discord:333333', identityId: 'discord-id', provider: 'discord', channelId: '222222', guildId: 'dm', authorId: '444444', body: 'Investigate from DM' };
  await fixture.gateways[1].deliver(event);
  await fixture.gateways[1].deliver({ ...event, id: 'discord:555555', body: 'Follow-up' });
  expect((await fixture.driver.store.read('project')).items).toHaveLength(1);
  expect(fixture.driver.calls.notices).toHaveLength(1);
  const item = (await fixture.driver.store.read('project')).items[0];
  const bot = (await fixture.driver.config.read('project')).definitions[0];
  expect(await fixture.runtime.resolveDiscordTarget({ project: fixture.driver.project, bot, item })).toEqual({ guildId: 'dm', channelId: '222222', recipientId: '444444' });
  await fixture.driver.config.setApproval('project', '.openchamber/people.json', null);
  await expect(fixture.runtime.resolveDiscordTarget({ project: fixture.driver.project, bot, item })).rejects.toMatchObject({ code: 'BOT_DISCORD_PERSON_DENIED' });
  await expect(fixture.gateways[1].deliver({ ...event, id: 'discord:666666' })).rejects.toMatchObject({ code: 'BOT_EVENT_NOT_AUTHORIZED' });
});

it('uses the single persisted channel and refuses ambiguous or removed outbound destinations', async () => {
  const fixture = await setup();
  const item = await fixture.driver.admit();
  const settings = await fixture.driver.config.read('project'); const bot = settings.definitions[0];
  expect(await fixture.runtime.resolveDiscordTarget({ project: fixture.driver.project, bot, item })).toEqual(bot.discord.channels[0]);
  await fixture.driver.config.update('project', { ...settings, definitions: [{ ...bot, discord: { channels: [...bot.discord.channels, { guildId: '111111', channelId: '999999' }] } }] });
  await expect(fixture.runtime.resolveDiscordTarget({ project: fixture.driver.project, bot, item })).rejects.toMatchObject({ code: 'BOT_DISCORD_DESTINATION_AMBIGUOUS' });
  await fixture.driver.config.update('project', { ...settings, definitions: [{ ...bot, discord: { channels: [] } }] });
  await expect(fixture.runtime.resolveDiscordTarget({ project: fixture.driver.project, bot, item })).rejects.toMatchObject({ code: 'BOT_DISCORD_DESTINATION_REQUIRED' });
});

it('refuses stale conversation authority without redirecting to the current configured channel', async () => {
  let revision = 2;
  const fixture = await setup({ identities: { list: async () => [{ id: 'discord-id', revision, kind: 'discord-app' }] } });
  await fixture.runtime.start();
  await fixture.gateways[0].deliver({ id: 'discord:333333', provider: 'discord', channelId: '222222', guildId: '111111', authorId: '444444', body: 'Evidence' });
  const item = (await fixture.driver.store.read('project')).items[0];
  const settings = await fixture.driver.config.read('project'); const bot = settings.definitions[0];
  const request = { project: fixture.driver.project, bot, item };
  expect(await fixture.runtime.resolveDiscordTarget(request)).toEqual({ guildId: '111111', channelId: '222222' });
  await fixture.driver.config.update('project', { ...settings, definitions: [{ ...bot, discord: { channels: [{ guildId: '111111', channelId: '999999' }] } }] });
  await expect(fixture.runtime.resolveDiscordTarget(request)).rejects.toMatchObject({ code: 'BOT_DISCORD_CHANNEL_DENIED' });
  await fixture.driver.config.update('project', settings);
  revision = 3;
  await expect(fixture.runtime.resolveDiscordTarget(request)).rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
});

it('gives each active bot item its own receipt when two bots watch the same Jira issue', async () => {
  const fixture = await setup();
  const settings = await fixture.driver.config.read('project');
  await fixture.driver.config.update('project', { ...settings, definitions: [...settings.definitions, { ...settings.definitions[0], id: 'second' }] });
  await fixture.driver.admit({ kind: 'jira', id: 'TEST-7' });
  await fixture.driver.runtime.admit('project', 'second', { source: { kind: 'jira', id: 'TEST-7' }, title: 'Same issue, another bot' });
  await fixture.runtime.start(); await fixture.runtime.tick();
  expect(fixture.driver.calls.notices).toHaveLength(2);
  expect(new Set(fixture.driver.calls.notices.map((notice) => notice.item.id)).size).toBe(2);
});

it('starts a new Gateway on the next save after the previous one halted, with nothing else changed', async () => {
  const halted = new Set();
  const fixture = await setup({ createGateway: (value) => {
    const gateway = { ...value, start: async () => {}, stop: async () => { gateway.stopped = true; }, halted: () => halted.has(gateway) };
    fixture.gateways.push(gateway);
    return gateway;
  } });
  await fixture.runtime.start();
  await fixture.runtime.reconfigure();
  expect(fixture.gateways).toHaveLength(1);
  // The owner stopped for good, for example on a frame larger than it accepts.
  halted.add(fixture.gateways[0]);

  await fixture.runtime.reconfigure();

  expect(fixture.gateways).toHaveLength(2);
  expect(fixture.gateways[0].stopped).toBe(true);
});
