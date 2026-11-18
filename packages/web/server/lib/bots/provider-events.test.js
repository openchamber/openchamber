import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createBotProviderEventStore, pollBotJiraComments } from './provider-events.js';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const setup = async (options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-events-test-'));
  directories.push(dataDir);
  return { dataDir, store: createBotProviderEventStore({ dataDir, ...options }) };
};
const scope = { provider: 'discord', identityId: 'identity-one', revision: 1 };
const event = { id: 'discord:12345678', provider: 'discord', identityId: 'identity-one', authorId: 'person-one', body: 'A question' };

it('persists cursor and pending event before delivery, resumes failures and deduplicates provider IDs', async () => {
  const { store, dataDir } = await setup();
  await store.record(scope, { expectedCursor: null, cursor: 1, events: [event, event] });
  await expect(store.drain(scope, async () => {
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'bot-provider-events.json'), 'utf8'));
    expect(Object.values(persisted.streams)[0]).toMatchObject({ cursor: 1, entries: [{ delivered: false }] });
    throw new Error('engine unavailable');
  })).rejects.toThrow('engine unavailable');
  const reloaded = createBotProviderEventStore({ dataDir });
  const delivered = [];
  await reloaded.drain(scope, async (entry) => delivered.push(entry.id));
  await reloaded.record(scope, { expectedCursor: 1, cursor: 2, events: [event] });
  await reloaded.drain(scope, async (entry) => delivered.push(entry.id));
  expect(delivered).toEqual([event.id]);
  expect((await fs.stat(path.join(dataDir, 'bot-provider-events.json'))).mode & 0o777).toBe(0o600);
  await expect(reloaded.record(scope, { expectedCursor: 1, cursor: 3, events: [] })).rejects.toMatchObject({ code: 'BOT_EVENT_CURSOR_CHANGED' });
});

it('separates identities and retains pending events after failed cursor writes', async () => {
  const { store, dataDir } = await setup();
  await store.record(scope, { expectedCursor: null, cursor: 1, events: [event] });
  const other = { ...scope, identityId: 'identity-two' };
  expect((await store.read(other)).cursor).toBeNull();
  const broken = createBotProviderEventStore({ dataDir, fsImpl: { ...fs, rename: async () => { throw new Error('disk full'); } } });
  await expect(broken.record(scope, { expectedCursor: 1, cursor: 2, events: [] })).rejects.toMatchObject({ code: 'BOT_EVENTS_WRITE_FAILED' });
  expect((await store.read(scope))).toMatchObject({ cursor: 1, entries: [{ delivered: false }] });
});

it('polls active Jira comments with a timestamp watermark, survives deletion-shifted offsets and ignores app comments', async () => {
  const { store } = await setup();
  let comments = [
    { id: '1', authorId: 'human', human: true, body: 'First', createdAt: '2026-10-21T00:00:00.000Z' },
    { id: '2', authorId: 'app', human: false, body: 'Own write', createdAt: '2026-10-21T01:00:00.000Z' },
  ];
  const starts = [];
  const services = { read: async ({ input }) => {
    starts.push(input.startAt);
    return { comments, total: comments.length, nextStartAt: null };
  } };
  const delivered = [];
  const options = { services, eventStore: store, identityId: 'jira-one', identityRevision: 1,
    target: { projectKey: 'TEST', issueKey: 'TEST-7' }, deliver: async (entry) => delivered.push(entry.id) };
  await pollBotJiraComments(options);
  comments = [comments[1], { id: '3', authorId: 'another-human', human: true, body: 'After deletion', createdAt: '2026-10-22T00:00:00.000Z' }];
  await pollBotJiraComments(options);
  await pollBotJiraComments(options);
  expect(delivered).toEqual(['jira:TEST-7:1', 'jira:TEST-7:3']);
  expect(starts).toEqual([0, 0, 0]);
});

it('does not advance a Jira watermark when pagination fails', async () => {
  const { store } = await setup();
  const target = { projectKey: 'TEST', issueKey: 'TEST-7' };
  const services = { read: async ({ input }) => {
    if (input.startAt) throw new Error('upstream failure');
    return { comments: [{ id: '1', authorId: 'human', human: true, body: 'First', createdAt: '2026-10-21T00:00:00.000Z' }],
      total: 2, nextStartAt: 1 };
  } };
  await expect(pollBotJiraComments({ services, eventStore: store, identityId: 'jira-one', identityRevision: 1, target, deliver: async () => {} })).rejects.toThrow('upstream failure');
  expect((await store.read({ provider: 'jira', identityId: 'jira-one', identityRevision: 1, target })).cursor).toBeNull();
});
