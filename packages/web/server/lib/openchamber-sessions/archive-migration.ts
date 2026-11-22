// Carries the fork's local archive file (sessions-archive.json) into OpenCode's
// own archive. A fork module: the upstream migration in session-archive.ts
// forgot each entry as soon as OpenCode answered the update, one full-file
// write per session. Here an entry is forgotten only after OpenCode reads the
// session back archived (or restored), so an OpenCode that accepts `archived`
// and ignores it (2.0.x did) cannot make an archived session reappear, and the
// confirmed entries are forgotten in batches, so 27,800 entries take about a
// hundred file writes instead of 27,800.

import { hasMessage, hasTag, isTimestamp } from './contracts.js';
import type { createArchiveStore } from './archive-store.js';
import type { OpenCodeSessionArchive } from './session-archive.js';

const CONCURRENCY = 6;
const FORGET_BATCH = 250;

type Outcome = 'confirmed' | 'missing' | 'failed' | 'unconfirmed' | 'gone';

export interface ArchiveMigrationResult {
  /** Entries still in the file after both passes; the next start retries them. */
  remaining: number;
  /** Entries OpenCode now holds as the file did (archived, or restored for an explicit unarchive). */
  confirmed: number;
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
}

const describeFailure = <Failure>(error: Failure) => (hasMessage(error) ? error.message : undefined) ?? error;

export const createArchiveMigration = ({ store, openCode, runForSession }: ArchiveMigrationOptions) => {
  const pushAndConfirm = async (id: string, archived: boolean): Promise<Outcome> => {
    try {
      await openCode.setArchived(id, archived);
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
    return isTimestamp(readBack) === archived ? 'confirmed' : 'unconfirmed';
  };

  const migrateOne = (id: string) => runForSession(id, async (): Promise<Outcome> => {
    // Read inside the session's turn: a user archive or restore that ran
    // first has already forgotten the entry and pushed its own state.
    const entry = await store.entry(id);
    if (entry === undefined) return 'gone';
    return pushAndConfirm(id, entry !== null);
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
        if (outcome === 'confirmed' || outcome === 'missing') acknowledged.push(id);
        if (acknowledged.length >= FORGET_BATCH) await flush();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, lane));
    await flush();
    return outcomes;
  };

  return async (): Promise<ArchiveMigrationResult> => {
    const first = await runPass(Object.keys(await store.getAll()));
    const retry = [...first].filter(([, outcome]) => outcome === 'failed' || outcome === 'unconfirmed').map(([id]) => id);
    const second = retry.length > 0 ? await runPass(retry) : new Map<string, Outcome>();
    const final = new Map([...first, ...second]);
    const count = (outcome: Outcome) => [...final.values()].filter((value) => value === outcome).length;
    const result = {
      remaining: Object.keys(await store.getAll()).length,
      confirmed: count('confirmed'),
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
