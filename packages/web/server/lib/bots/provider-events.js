import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { BotServiceError, opaqueId, parse, text } from './services/contracts.js';

const cursorSchema = z.union([z.null(), z.number().int().nonnegative(), z.string().max(1_000),
  z.object({ sessionId: text, sequence: z.number().int().nonnegative(), resumeUrl: z.string().max(500) }).strict()]);
const eventSchema = z.object({
  id: text, provider: z.enum(['jira', 'discord']), identityId: opaqueId,
  authorId: text, body: z.string().max(60_000),
  issueKey: text.optional(), channelId: text.optional(), guildId: text.optional(), threadId: text.optional(),
}).strict();
const entrySchema = z.object({ event: eventSchema, delivered: z.boolean() }).strict();
const streamSchema = z.object({ cursor: cursorSchema, entries: z.array(entrySchema).max(2_000) }).strict()
  .refine((value) => new Set(value.entries.map((entry) => entry.event.id)).size === value.entries.length);
const storeSchema = z.object({ version: z.literal(1), streams: z.record(z.string().regex(/^[a-f0-9]{64}$/), streamSchema) }).strict();

/** The callback must durably deduplicate event.id in the engine's inbox. */
export function createBotProviderEventStore({ dataDir, fsImpl = fs }) {
  const filePath = path.join(dataDir, 'bot-provider-events.json');
  let queue = Promise.resolve();
  const transaction = (operation) => {
    const next = queue.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl }));
    queue = next.catch(() => {});
    return next;
  };
  const readState = async () => {
    let raw;
    try { raw = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, streams: {} };
      throw new BotServiceError('BOT_EVENTS_UNREADABLE', 'Bot events could not be read.');
    }
    try { return storeSchema.parse(JSON.parse(raw)); }
    catch { throw new BotServiceError('BOT_EVENTS_INVALID', 'Bot event storage is invalid.'); }
  };
  const writeState = async (state) => {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.mkdir(dataDir, { recursive: true });
      await fsImpl.writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, filePath);
    } catch {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw new BotServiceError('BOT_EVENTS_WRITE_FAILED', 'Bot event delivery stopped because its cursor could not be saved.');
    }
  };
  const streamKey = (scope) => digestMutationInput(scope);
  const read = (scope) => transaction(async () => (await readState()).streams[streamKey(scope)] ?? { cursor: null, entries: [] });
  const record = (scope, { expectedCursor, cursor, events }) => transaction(async () => {
    parse(cursorSchema, expectedCursor); parse(cursorSchema, cursor);
    const parsedEvents = parse(z.array(eventSchema).max(100), events);
    const key = streamKey(scope);
    const state = await readState();
    const stream = state.streams[key] ?? { cursor: null, entries: [] };
    if (digestMutationInput(stream.cursor) !== digestMutationInput(expectedCursor)) {
      throw new BotServiceError('BOT_EVENT_CURSOR_CHANGED', 'Another bot event reader advanced this cursor.');
    }
    for (const event of parsedEvents) {
      if (!stream.entries.some((entry) => entry.event.id === event.id)) stream.entries.push({ event, delivered: false });
    }
    while (stream.entries.length > 2_000) {
      const firstDelivered = stream.entries.findIndex((entry) => entry.delivered);
      if (firstDelivered < 0) throw new BotServiceError('BOT_EVENT_BACKLOG_FULL', 'Bot event delivery must resume before more events can be read.');
      stream.entries.splice(firstDelivered, 1);
    }
    stream.cursor = cursor;
    state.streams[key] = stream;
    await writeState(state);
    return stream;
  });
  const drain = (scope, deliver) => {
    const key = streamKey(scope);
    return withSourceControlFileLock(`${filePath}.delivery-${key}.lock`, async () => {
      const pending = (await read(scope)).entries.filter((entry) => !entry.delivered);
      for (const { event } of pending) {
        await deliver(event);
        await transaction(async () => {
          const state = await readState();
          const entry = state.streams[key]?.entries.find((candidate) => candidate.event.id === event.id);
          if (!entry) throw new BotServiceError('BOT_EVENT_MISSING', 'The bot event receipt is missing.');
          entry.delivered = true;
          await writeState(state);
        });
      }
      return { delivered: pending.length };
    });
  };
  return Object.freeze({ read, record, drain });
}

/** Poll only an active item's issue. Persist the page and cursor before delivery. */
export async function pollBotJiraComments({ services, eventStore, identityId, identityRevision, target, deliver }) {
  const scope = { provider: 'jira', identityId, identityRevision, target };
  let saved = await eventStore.read(scope);
  await eventStore.drain(scope, deliver);
  if (saved.cursor !== null && (!z.string().safeParse(saved.cursor).success || !Number.isFinite(Date.parse(saved.cursor)))) {
    throw new BotServiceError('BOT_EVENT_CURSOR_INVALID', 'The Jira comment cursor is invalid.');
  }
  const after = saved.cursor === null ? -1 : Date.parse(saved.cursor);
  let newest = after;
  let startAt = 0;
  let expectedTotal;
  let pages = 0;
  for (;;) {
    const page = await services.read({ identityId, identityRevision, operation: 'jira.comments', target, input: { startAt } });
    expectedTotal ??= page.total;
    if (page.total !== expectedTotal) throw new BotServiceError('BOT_JIRA_COMMENTS_CHANGED', 'Jira comments changed during pagination. The saved cursor is unchanged.');
    for (const entry of page.comments) newest = Math.max(newest, Date.parse(entry.createdAt));
    const events = page.comments.filter((entry) => entry.human && Date.parse(entry.createdAt) >= after).map((entry) => ({
      id: `jira:${target.issueKey}:${entry.id}`, provider: 'jira', identityId,
      authorId: entry.authorId, body: entry.body, issueKey: target.issueKey,
    }));
    // Offsets shift after deletion. Scan from zero, and advance the time watermark
    // only after every page completed. Boundary timestamps retain ID deduplication.
    saved = await eventStore.record(scope, { expectedCursor: saved.cursor, cursor: saved.cursor, events });
    await eventStore.drain(scope, deliver);
    if (page.nextStartAt === null) {
      const cursor = newest < 0 ? saved.cursor : new Date(newest).toISOString();
      saved = await eventStore.record(scope, { expectedCursor: saved.cursor, cursor, events: [] });
      return { cursor: saved.cursor };
    }
    if (++pages >= 20) throw new BotServiceError('BOT_JIRA_COMMENT_LIMIT', 'The active Jira issue exceeds 2,000 comments. Its watermark is unchanged.');
    startAt = page.nextStartAt;
  }
}
