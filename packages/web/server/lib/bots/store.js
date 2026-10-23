import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { assertEffectTransition, assertItemTransition, botItemSchema, botOwnerSchema, TERMINAL_ITEM_STATES } from './schema.js';

const rootSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), items: z.array(z.unknown()) }).strict();
const archiveRecordSchema = z.object({ version: z.literal(1), item: botItemSchema }).strict();
const projectIdSchema = z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._:-]*$/);
const monthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const empty = () => ({ revision: 0, items: [] });
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Process-restart durable snapshots. All methods use the same project lock. */
export const createBotStore = ({ projectsDirPath, fsImpl = fs, now = Date.now, owner = { pid: process.pid, host: os.hostname() } }) => {
  const actor = botOwnerSchema.parse(owner);
  const filePathFor = (projectId) => path.join(projectsDirPath, projectConfigFileStemOf(projectIdSchema.parse(projectId)), 'bots.json');
  const archiveDirectoryFor = (projectId) => path.join(path.dirname(filePathFor(projectId)), 'bots-archive');
  const locked = (projectId, operation) => withSourceControlFileLock(`${filePathFor(projectId)}.lock`, operation, { fsImpl, waitMs: 10_000 });

  const readFile = async (file) => {
    try {
      const handle = await fsImpl.open(file, 'r');
      try {
        const stat = await handle.stat();
        if (stat.size > MAX_FILE_BYTES) throw new Error('Bot data file exceeds the size boundary');
        return await handle.readFile('utf8');
      } finally { await handle.close(); }
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
  const readSnapshot = async (projectId) => {
    const raw = await readFile(filePathFor(projectId));
    if (raw === null) return empty();
    const root = rootSchema.parse(JSON.parse(raw));
    const items = new Map();
    for (const entry of root.items) {
      const parsed = botItemSchema.safeParse(entry);
      if (parsed.success && !items.has(parsed.data.id)) items.set(parsed.data.id, parsed.data);
    }
    return { revision: root.revision, items: [...items.values()] };
  };
  const readArchiveRecords = async (projectId, month) => {
    if (month !== undefined) monthSchema.parse(month);
    const directory = archiveDirectoryFor(projectId);
    let names;
    try { names = await fsImpl.readdir(directory); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const items = new Map();
    for (const name of names.filter((name) => /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/.test(name) && (!month || name === `${month}.jsonl`)).sort()) {
      const raw = await readFile(path.join(directory, name));
      if (raw === null) throw new Error('Bot archive disappeared while locked');
      // A killed append can leave a torn final line. Only newline-committed records count.
      for (const line of raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.version !== 1) throw new Error('Unsupported bot archive record version');
        const parsed = archiveRecordSchema.safeParse(record);
        if (parsed.success && !items.has(parsed.data.item.id)) items.set(parsed.data.item.id, parsed.data.item);
      }
    }
    return [...items.values()];
  };
  const currentSnapshot = async (projectId) => {
    const snapshot = await readSnapshot(projectId);
    const archivedIds = new Set((await readArchiveRecords(projectId)).map((item) => item.id));
    return { ...snapshot, items: snapshot.items.filter((item) => !archivedIds.has(item.id)) };
  };
  const write = async (projectId, snapshot) => {
    const file = filePathFor(projectId);
    const temporary = `${file}.tmp-${randomUUID()}`;
    const bytes = JSON.stringify({ version: 1, ...snapshot }, null, 2);
    if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw new Error('Bot snapshot exceeds the size boundary');
    try {
      await fsImpl.writeFile(temporary, bytes, { encoding: 'utf8', mode: 0o600 });
      await fsImpl.rename(temporary, file);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };

  const commitItems = (current, proposed) => {
    const timestamp = now();
    const previous = new Map(current.items.map((item) => [item.id, item]));
    const ids = new Set();
    const origins = new Set();
    const items = proposed.map((input) => {
      const old = previous.get(input.id);
      const candidate = { ...input };
      if (TERMINAL_ITEM_STATES.includes(input.state)) candidate.finishedAt = old?.finishedAt ?? input.finishedAt ?? timestamp;
      const item = botItemSchema.parse(candidate);
      if (ids.has(item.id)) throw new Error('Duplicate bot item id');
      ids.add(item.id);
      const origin = JSON.stringify([item.botId, item.source.kind, item.source.id]);
      if (origins.has(origin)) throw new Error('Duplicate bot item source');
      origins.add(origin);
      if (!old) {
        if (item.state !== 'queued' || item.revision !== 0 || item.transitions.length || item.effects.some((effect) => effect.state !== 'prepared')) throw new Error('New bot items must be queued and undispatched');
        return { ...item, revision: 1, owner: actor, createdAt: timestamp, updatedAt: timestamp,
          transitions: [{ from: null, to: 'queued', at: timestamp, revision: 1, owner: actor, reason: 'Created' }] };
      }
      if (same(old, item)) return old;
      if (item.botId !== old.botId || !same(item.source, old.source) || item.createdAt !== old.createdAt) throw new Error('Bot item identity is immutable');
      if (item.revision !== old.revision || !same(item.transitions, old.transitions)) throw new Error('Stale bot item revision or changed transition history');
      assertItemTransition(old.state, item.state);
      if (item.tokens.total < old.tokens.total) throw new Error('Bot token usage cannot decrease');
      const effects = new Map(item.effects.map((effect) => [effect.key, effect]));
      for (const effect of old.effects) {
        const next = effects.get(effect.key);
        if (!next) throw new Error('Durable bot effects cannot be removed');
        assertEffectTransition(effect, next);
      }
      const oldKeys = new Set(old.effects.map((effect) => effect.key));
      if (item.effects.some((effect) => !oldKeys.has(effect.key) && effect.state !== 'prepared')) throw new Error('New effects must be prepared before dispatch');
      const nextRevision = old.revision + 1;
      const transitions = item.state === old.state ? old.transitions : [...old.transitions,
        { from: old.state, to: item.state, at: timestamp, revision: nextRevision, owner: actor, reason: item.wait?.reason ?? `Entered ${item.state}` }];
      return { ...item, revision: nextRevision, updatedAt: timestamp, owner: actor, transitions };
    });
    if (current.items.some((item) => !ids.has(item.id))) throw new Error('Use archive to remove bot items');
    return items;
  };

  const read = async (projectId) => locked(projectId, () => currentSnapshot(projectId));
  /** change(snapshot) -> { snapshot?: { revision, items }, result? }. No snapshot means no write. */
  const update = async (projectId, change) => locked(projectId, async () => {
    const current = await currentSnapshot(projectId);
    const outcome = await change(structuredClone(current));
    if (!outcome.snapshot) return outcome.result;
    if (outcome.snapshot.revision !== current.revision) throw new Error('Stale bot snapshot revision');
    const items = commitItems(current, outcome.snapshot.items);
    const archived = await readArchiveRecords(projectId);
    const archivedIds = new Set(archived.map((item) => item.id));
    if (items.some((item) => archivedIds.has(item.id))) throw new Error('Archived bot item ids cannot be reused');
    const archivedSources = new Set(archived.map((item) => JSON.stringify([item.botId, item.source.kind, item.source.id])));
    if (items.some((item) => archivedSources.has(JSON.stringify([item.botId, item.source.kind, item.source.id])))) throw new Error('Archived bot item sources cannot be repeated');
    const committed = { revision: current.revision + 1, items };
    await write(projectId, committed);
    return outcome.result === undefined ? committed : outcome.result;
  });
  const readArchive = async (projectId, month) => locked(projectId, () => readArchiveRecords(projectId, month));
  /** Archive terminal items finished before the cutoff; never evict on ordinary writes. */
  const archive = async (projectId, { before = now(), itemIds } = {}) => locked(projectId, async () => {
    z.number().int().nonnegative().parse(before);
    if (itemIds !== undefined) z.array(z.string().min(1)).parse(itemIds);
    const raw = await readSnapshot(projectId);
    const archived = await readArchiveRecords(projectId);
    const known = new Set(archived.map((item) => item.id));
    const selected = raw.items.filter((item) => !known.has(item.id) && TERMINAL_ITEM_STATES.includes(item.state)
      && item.finishedAt < before && (!itemIds || itemIds.includes(item.id))
      && item.effects.every((effect) => ['succeeded', 'refused'].includes(effect.state)));
    const directory = archiveDirectoryFor(projectId);
    await fsImpl.mkdir(directory, { recursive: true });
    for (const item of selected) {
      const month = new Date(item.finishedAt).toISOString().slice(0, 7);
      monthSchema.parse(month);
      const file = path.join(directory, `${month}.jsonl`);
      const existing = await readFile(file);
      const handle = await fsImpl.open(file, 'a', 0o600);
      try {
        // A failed append never owns an id. Remove its uncommitted tail before retry.
        if (existing !== null && !existing.endsWith('\n')) await handle.truncate(Buffer.byteLength(existing.slice(0, existing.lastIndexOf('\n') + 1)));
        const line = `${JSON.stringify({ version: 1, item })}\n`;
        if (Buffer.byteLength(existing ?? '') + Buffer.byteLength(line) > MAX_FILE_BYTES) throw new Error('Bot archive exceeds the size boundary');
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      known.add(item.id);
    }
    const snapshot = { revision: raw.revision + 1, items: raw.items.filter((item) => !known.has(item.id)) };
    if (snapshot.items.length !== raw.items.length) await write(projectId, snapshot);
    return { archived: selected.map((item) => item.id), snapshot: snapshot.items.length !== raw.items.length ? snapshot : raw };
  });
  return { read, update, archive, readArchive, filePathFor };
};
