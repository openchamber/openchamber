import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';

import { createMessageSearchIndexer } from './indexer.js';
import { loadSqliteOpener } from './sqlite.js';
import { buildSnippet, openMessageSearchStore, toMatchExpression, toSearchTerms } from './store.js';

const INDEX_FILE = 'message-search.sqlite';
// Whether the file holds reasoning rows, so a start can tell what to redo.
const REASONING_META_KEY = 'reasoning';
// SQLite's write-ahead log and its shared-memory index live beside the file.
const INDEX_FILE_SUFFIXES = ['', '-wal', '-shm'];
const MAX_LIMIT = 200;

// The hub's envelope: `directory` is 'global' for events with no location.
const envelopeSchema = z.object({ directory: z.string().nullish() });
const payloadDirectorySchema = z.object({ properties: z.object({ directory: z.string() }) });

/**
 * Owns the search index for this server's OpenCode. Search is opt-in
 * (`messageSearchEnabled`): while it is off nothing runs, no file is opened,
 * no event is looked at. Turning it on opens the index, follows the event
 * stream and walks the session list, which fills in whatever changed while it
 * was off. Turning it off stops all of that and keeps the file, so the next
 * start only catches up. Without a SQLite builtin search is unsupported.
 *
 * Reasoning is a second opt-in (`messageSearchReasoningEnabled`). Turning it
 * on makes the next walk read every session's agent records again; turning it
 * off drops the reasoning rows at once.
 */
export const createMessageSearchRuntime = ({
  dataDir,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub,
  // () => Promise<{ enabled: boolean, reasoning: boolean }>, from settings.json.
  readSettings,
  logger = console,
}) => {
  const indexPath = path.join(dataDir, INDEX_FILE);
  const open = loadSqliteOpener();
  let enabled = false;
  let reasoning = false;
  let engine = null;
  let failed = false;
  // Start, stop and delete run one after another, in the order asked.
  let transition = Promise.resolve();
  const enqueue = (work) => {
    const run = transition.then(work);
    transition = run.catch((error) => {
      logger.warn?.('[message-search]', error?.message ?? error);
    });
    return run;
  };

  const createClient = (directory) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    // v2 scopes by header and rejects non-ASCII header values.
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers });
  };

  // Brings the file in line with the reasoning switch. True when reasoning has
  // to be read in, which the next session walk does.
  const reconcileReasoning = (store) => {
    const indexed = store.readMeta(REASONING_META_KEY) === '1';
    if (reasoning && !indexed) {
      store.rereadAssistantRecords();
      store.writeMeta(REASONING_META_KEY, '1');
      return true;
    }
    // Always, not only on a change: a session read while the switch flipped
    // off can leave a stray row behind.
    if (!reasoning) {
      store.deleteRole('reasoning');
      store.writeMeta(REASONING_META_KEY, '0');
    }
    return false;
  };

  const startEngine = () => {
    const store = openMessageSearchStore(open(indexPath));
    reconcileReasoning(store);
    const indexer = createMessageSearchIndexer({ store, createClient, includeReasoning: () => reasoning, logger });
    const unsubscribeEvents = globalEventHub.subscribeEvent((event) => {
      const envelope = envelopeSchema.safeParse(event);
      const directory = envelope.success && envelope.data.directory !== 'global' ? envelope.data.directory ?? '' : '';
      for (const payload of event?.translated?.() ?? []) {
        const own = payloadDirectorySchema.safeParse(payload);
        indexer.processPayload(payload, directory || (own.success ? own.data.properties.directory : ''));
      }
    });
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') indexer.onConnected();
    });
    if (globalEventHub.isConnected?.()) indexer.onConnected();
    return {
      store,
      indexer,
      stop: async () => {
        unsubscribeEvents?.();
        unsubscribeStatus?.();
        indexer.stop();
        // A session being read finishes before the file closes under it.
        await indexer.idle();
        store.close();
      },
    };
  };

  const apply = async () => {
    if (enabled && !engine && open) {
      try {
        engine = startEngine();
        failed = false;
      } catch (error) {
        failed = true;
        logger.warn?.('[message-search] index unavailable:', error?.message ?? error);
      }
    } else if (!enabled && engine) {
      const running = engine;
      engine = null;
      await running.stop();
    }
  };

  const indexSize = async () => {
    let bytes = 0;
    for (const suffix of INDEX_FILE_SUFFIXES) {
      const stat = await fsPromises.stat(`${indexPath}${suffix}`).catch(() => null);
      if (stat) bytes += stat.size;
    }
    return bytes;
  };

  if (open) {
    void enqueue(async () => {
      const settings = await readSettings();
      enabled = settings.enabled === true;
      reasoning = settings.reasoning === true;
      await apply();
    });
  }

  return {
    supported: Boolean(open),

    /** Follows the setting; called after `messageSearchEnabled` is saved. */
    setEnabled: (next) => enqueue(async () => {
      enabled = next === true;
      await apply();
    }),

    /** Follows `messageSearchReasoningEnabled`; applied to the file only while search runs. */
    setReasoningEnabled: (next) => enqueue(async () => {
      reasoning = next === true;
      if (engine && reconcileReasoning(engine.store) && globalEventHub.isConnected?.()) engine.indexer.onConnected();
    }),

    /**
     * Deletes the index file. While search is on, a fresh one is started at
     * once, so this is "rebuild"; while it is off, the disk space comes back.
     */
    deleteIndex: () => enqueue(async () => {
      if (engine) {
        const running = engine;
        engine = null;
        await running.stop();
      }
      for (const suffix of INDEX_FILE_SUFFIXES) {
        await fsPromises.rm(`${indexPath}${suffix}`, { force: true });
      }
      await apply();
    }),

    /**
     * `null` match means the query has no word long enough to look up. The
     * answer then says so instead of pretending nothing matched. `null`
     * overall means no index is running.
     */
    search: ({ query, sessionId, directories, role, includeReasoning, before, limit, order }) => {
      if (!engine) return null;
      const match = toMatchExpression(query);
      if (!match) return { status: 'query-too-short', hits: [] };
      const size = Math.min(Math.max(1, limit), MAX_LIMIT);
      const hits = engine.store.search({
        match,
        sessionId,
        directories,
        role,
        // Stray rows from a switch that just flipped off stay out too.
        includeReasoning: reasoning && includeReasoning !== false,
        before,
        limit: size + 1,
        order,
      });
      const terms = toSearchTerms(query);
      const page = hits.slice(0, size);
      const last = page[page.length - 1];
      return {
        status: 'ok',
        hits: page.map((hit) => ({
          id: hit.id,
          sessionId: hit.sessionId,
          role: hit.role,
          createdAt: hit.createdAt,
          sessionTitle: hit.sessionTitle,
          directory: hit.directory,
          snippet: buildSnippet(hit.text, terms),
        })),
        // Pages by row: a reply and its reasoning share the message id.
        next: hits.length > size && last ? { createdAt: last.createdAt, id: last.rowId } : null,
        index: engine.indexer.status(),
      };
    },

    /** What the Settings page shows; the counts exist only while the index is open. */
    status: async () => {
      if (!open) return { state: 'unsupported', sizeBytes: 0, index: null };
      // A switch or delete already asked for is reported as done.
      await transition;
      const sizeBytes = await indexSize();
      if (engine) return { state: 'on', sizeBytes, index: engine.indexer.status() };
      return { state: enabled && failed ? 'failed' : 'off', sizeBytes, index: null };
    },

    stop: () => enqueue(async () => {
      enabled = false;
      await apply();
    }),
  };
};
