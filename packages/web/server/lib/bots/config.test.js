import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createBotsConfig, parseConfigEdit, readBotsConfig } from './config.js';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const setup = async () => {
  const directory = await fs.mkdtemp('/tmp/opencode/bots-config-');
  directories.push(directory);
  const runtime = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: directory });
  return { directory, runtime, config: createBotsConfig({ projectConfigRuntime: runtime }) };
};
const definition = () => ({ id: 'bugs', name: 'Bugs', mission: 'Fix verified bugs' });

it('defaults old projects and roundtrips all definition fields without accepting user approvals', async () => {
  const { config, runtime } = await setup();
  expect(await config.read('p')).toEqual({ concurrency: 2, retentionDays: 90, definitions: [], approvals: {} });
  await runtime.updateSuggestedTasksSection('p', () => ({ enabled: true, future: 'preserved' }));
  const bot = {
    ...definition(), enabled: false, schedule: { kind: 'weekly', time: '10:30', weekdays: [1, 5], timezone: 'UTC' },
    source: { kind: 'jira', jql: 'project = QA', maxItems: 200 },
    models: { investigation: { useDefaults: false, providerID: 'p', modelID: 'm', variant: 'high', agent: 'plan' }, fixing: { useDefaults: true }, judge: { useDefaults: true } },
    mcp: [{ server: 'jira', tools: { search: 'allow', edit: 'ask' } }], correctionMcp: [{ server: 'jira', tools: { search: 'deny' } }], web: true,
    permissionMode: 'ask', goalTokenBudget: 100_000, notify: 'finish', isolated: true,
    identity: { github: { kind: 'app', identityId: 'gh-app' }, jira: { identityId: 'jira-user' }, discord: { identityId: 'discord-app' } },
    limits: { dailyTokens: 1_000_000, maxPendingHuman: 20 }, proof: { command: 'bun', args: ['test', '{files}'] }, jira: { doneTransition: '31' },
    discord: { channels: [{ guildId: '111111', channelId: '222222' }] },
  };
  const input = { concurrency: 4, retentionDays: 365, definitions: [bot], approvals: { forged: 'f'.repeat(64) } };
  await config.update('p', input);
  await config.setApproval('p', '.agents/areas/db.md', 'a'.repeat(64));
  await config.update('p', input);
  const restarted = createBotsConfig({ projectConfigRuntime: runtime });
  expect(await restarted.read('p')).toEqual({ ...parseConfigEdit(input), approvals: { '.agents/areas/db.md': 'a'.repeat(64) } });
  expect(await runtime.readSuggestedTasksSection('p')).toEqual({ enabled: true, future: 'preserved' });
  await config.setApproval('p', '.agents/areas/db.md', null);
  expect((await config.read('p')).approvals).toEqual({});
});

it('isolates approval and bots writes under the shared project lock', async () => {
  const { directory, config, runtime } = await setup();
  const second = createBotsConfig({ projectConfigRuntime: createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: directory }) });
  await Promise.all([
    config.update('p', { definitions: [definition()] }),
    second.setApproval('p', '.openchamber/people.json', 'b'.repeat(64)),
    runtime.updateSuggestedTasksSection('p', () => ({ enabled: true })),
  ]);
  expect((await config.read('p')).definitions).toHaveLength(1);
  expect((await config.read('p')).approvals['.openchamber/people.json']).toBe('b'.repeat(64));
  expect(await runtime.readSuggestedTasksSection('p')).toEqual({ enabled: true });
});

it('rejects invalid config, duplicate ids and broken reads without replacing the file', async () => {
  const { runtime, config } = await setup();
  expect(readBotsConfig(null).ok).toBe(false);
  for (const raw of [{ concurrency: 0 }, { definitions: [definition(), definition()] }, { definitions: [{ ...definition(), models: { fixing: { useDefaults: false } } }] }]) {
    expect(() => parseConfigEdit(raw)).toThrow();
  }
  const file = runtime.resolveProjectConfigPath('p');
  for (const bytes of ['{', JSON.stringify({ version: 1, bots: { concurrency: -1 } })]) {
    await fs.writeFile(file, bytes);
    await expect(config.read('p')).rejects.toThrow();
    await expect(config.update('p', {})).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  }
  await fs.rm(file);
  await fs.mkdir(file);
  await expect(config.read('p')).rejects.toThrow();
});

it('keeps defaults conservative while allowing all approved sources, identities and schedules', () => {
  const defaults = parseConfigEdit({ definitions: [definition()] }).definitions[0];
  expect(defaults).toMatchObject({ schedule: { kind: 'manual' }, web: false, isolated: false, notify: 'attention', permissionMode: 'default', limits: { dailyTokens: null, maxPendingHuman: null }, mcp: [], correctionMcp: [], discord: { channels: [] } });
  for (const kind of ['manual', 'daily', 'weekly', 'cron']) {
    expect(parseConfigEdit({ definitions: [{ ...definition(), schedule: { kind }, source: { kind: 'investigation', prompt: 'Find a bug', maxItems: 1000 }, identity: { github: { kind: 'account', accountId: 'account-1' } } }] }).definitions[0].schedule.kind).toBe(kind);
  }
});

it('rejects malformed and duplicate Discord channels without discarding persisted selections', async () => {
  const { config } = await setup();
  const discord = { channels: [{ guildId: '111111', channelId: '222222' }] };
  await config.update('p', { definitions: [{ ...definition(), discord }] });
  for (const channels of [[{ guildId: 'dm', channelId: '222222' }], [{ guildId: '111111', channelId: '0' }], [...discord.channels, ...discord.channels]]) {
    await expect(config.update('p', { definitions: [{ ...definition(), discord: { channels } }] })).rejects.toThrow();
  }
  expect((await config.read('p')).definitions[0].discord).toEqual(discord);
});
