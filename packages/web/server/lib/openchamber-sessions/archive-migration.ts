// Carries the fork's local archive file (sessions-archive.json) into OpenCode's
// own archive. A fork module: the upstream migration in session-archive.ts
// forgot each entry as soon as OpenCode answered the update, one full-file
// write per session. Here an entry is forgotten only after OpenCode reads the
// session back archived (or restored), so an OpenCode that accepts `archived`
// and ignores it (2.0.x did) cannot make an archived session reappear, and the
// confirmed entries are forgotten in batches, so 27,800 entries take about a
// hundred file writes instead of 27,800.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { hasCode, hasMessage, hasTag, isTimestamp } from './contracts.js';
import type { createArchiveStore } from './archive-store.js';
import type { OpenCodeSessionArchive } from './session-archive.js';

const CONCURRENCY = 6;
const FORGET_BATCH = 250;
/** The archive file as it was before the first migration forgot anything; read-only, never overwritten. */
export const MIGRATED_ARCHIVE_FILE_NAME = 'sessions-archive.migrated.json';

type Outcome = 'confirmed' | 'timeKept' | 'missing' | 'failed' | 'unconfirmed' | 'gone';

export interface ArchiveMigrationResult {
  /** Entries still in the file after both passes; the next start retries them. */
  remaining: number;
  /** Entries OpenCode now holds as the file did (archived, or restored for an explicit unarchive). */
  confirmed: number;
  /** Of those, archived entries OpenCode holds at the file's own time rather than its own. */
  timeKept: number;
  /** Entries for sessions OpenCode does not have; forgotten, since nothing can show them. */
  missing: number;
  /** Entries whose push failed in both passes. */
  failed: number;
  /** Entries OpenCode accepted but still reads back differently in both passes. */
  unconfirmed: number;
}

interface ArchiveMigrationOptions {
  store: ReturnType<typeof createArchiveStore>;
  openCode: OpenCodeSessionArchive;
  runForSession: <Result>(id: string, work: () => Promise<Result>) => Promise<Result>;
  fsPromises?: Pick<typeof fsDefault.promises, 'readFile' | 'writeFile'>;
}

const describeFailure = <Failure>(error: Failure) => (hasMessage(error) ? error.message : undefined) ?? error;

export const createArchiveMigration = ({ store, openCode, runForSession, fsPromises = fsDefault.promises }: ArchiveMigrationOptions) => {
  // The owner keeps the original archive times (OpenCode stamps its own), so
  // the file's bytes are copied aside once, before any entry is forgotten.
  // An existing copy is the original from an earlier start and is kept.
  // A failed copy stops the run: nothing is forgotten without it.
  const keepOriginal = async () => {
    const copyPath = pathDefault.join(pathDefault.dirname(store.filePath), MIGRATED_ARCHIVE_FILE_NAME);
    try {
      await fsPromises.writeFile(copyPath, await fsPromises.readFile(store.filePath), { flag: 'wx', mode: 0o444 });
      return true;
    } catch (error) {
      if (hasCode(error) && error.code === 'EEXIST') return true;
      console.warn('[openchamber-sessions] could not keep a copy of the archive file; the migration waits for the next start:', describeFailure(error));
      return false;
    }
  };

  const pushAndConfirm = async (id: string, entry: number | null): Promise<Outcome> => {
    const archived = entry !== null;
    try {
      // The original time where OpenCode takes one; an OpenCode that ignores it archives at its own time.
      if (entry !== null && openCode.archiveAt) await openCode.archiveAt(id, entry);
      else await openCode.setArchived(id, archived);
    } catch (error) {
      if (hasTag(error) && error._tag === 'SessionNotFoundError') return 'missing';
      console.warn(`[openchamber-sessions] could not carry the archive state of ${id} into OpenCode:`, describeFailure(error));
      return 'failed';
    }
    let readBack;
    try {
      readBack = await openCode.readArchivedAt(id);
    } catch (error) {
      console.warn(`[openchamber-sessions] could not confirm the archive state of ${id}:`, describeFailure(error));
      return 'failed';
    }
    if (readBack === undefined) return 'missing';
    if (isTimestamp(readBack) !== archived) return 'unconfirmed';
    return entry !== null && readBack === entry ? 'timeKept' : 'confirmed';
  };

  const migrateOne = (id: string) => runForSession(id, async (): Promise<Outcome> => {
    // Read inside the session's turn: a user archive or restore that ran
    // first has already forgotten the entry and pushed its own state.
    const entry = await store.entry(id);
    if (entry === undefined) return 'gone';
    return pushAndConfirm(id, entry);
  });

  const runPass = async (ids: string[]) => {
    const outcomes = new Map<string, Outcome>();
    const acknowledged: string[] = [];
    const flush = async () => {
      const batch = acknowledged.splice(0, acknowledged.length);
      if (batch.length > 0) await store.forget(batch);
    };
    let next = 0;
    const lane = async () => {
      while (next < ids.length) {
        const id = ids[next];
        next += 1;
        if (id === undefined) continue;
        const outcome = await migrateOne(id);
        outcomes.set(id, outcome);
        if (outcome === 'confirmed' || outcome === 'timeKept' || outcome === 'missing') acknowledged.push(id);
        if (acknowledged.length >= FORGET_BATCH) await flush();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, lane));
    await flush();
    return outcomes;
  };

  return async (): Promise<ArchiveMigrationResult> => {
    const pending = Object.keys(await store.getAll());
    if (pending.length > 0 && !(await keepOriginal())) {
      return { remaining: pending.length, confirmed: 0, timeKept: 0, missing: 0, failed: 0, unconfirmed: 0 };
    }
    const first = await runPass(pending);
    const retry = [...first].filter(([, outcome]) => outcome === 'failed' || outcome === 'unconfirmed').map(([id]) => id);
    const second = retry.length > 0 ? await runPass(retry) : new Map<string, Outcome>();
    const final = new Map([...first, ...second]);
    const count = (outcome: Outcome) => [...final.values()].filter((value) => value === outcome).length;
    const result = {
      remaining: Object.keys(await store.getAll()).length,
      confirmed: count('confirmed') + count('timeKept'),
      timeKept: count('timeKept'),
      missing: count('missing'),
      failed: count('failed'),
      unconfirmed: count('unconfirmed'),
    };
    if (result.unconfirmed > 0) {
      console.warn(`[openchamber-sessions] OpenCode accepted ${result.unconfirmed} archive changes but did not apply them; those stay in the local archive file`);
    }
    return result;
  };
};
