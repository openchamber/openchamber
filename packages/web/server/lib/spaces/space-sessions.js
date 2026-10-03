// The merged session list and the rules for what a space may claim in it or in its events.
// Pure: no Express, no transport. `host.js` feeds it what the spaces answered and the proxy
// asks it for the merged answer.
//
// A space's list and events are untrusted. A record or an event may name a directory under
// that space's own root only, and never a session id the host has: the host's id wins, the
// space's record is dropped and logged as a code, without its body. A space that does not
// answer keeps its last known sessions, marked stale; a missing answer never means deletion.

import { z } from 'zod';

import { sanitizeSessionListItem } from '../opencode/proxy.js';
import { isDirectoryOfSpace } from './dispatcher.js';

// How many host session ids are remembered for the collision rule. Older ones are forgotten
// first; a session the host listed or created recently is always among them.
const HOST_ID_MEMORY = 50_000;

/** Why a record or an event of a space was dropped. Logged as a code, never with the body. */
export const SPACE_DROP_CODES = Object.freeze({
  malformed: 'space_session_malformed',
  outsideRoot: 'space_session_outside_root',
  hostId: 'space_session_host_id',
  claimed: 'space_session_claimed',
  eventHostSession: 'space_event_host_session',
  eventOutsideRoot: 'space_event_outside_root',
});

// What the host reads of a record or an event before it decides; every other field is carried, not read.
const directorySchema = z.string().min(1);
const idSchema = z.string().min(1);
const recordSchema = z.object({ id: idSchema, location: z.object({ directory: directorySchema }).passthrough() }).passthrough();
const eventSchema = z.object({
  type: z.string(),
  data: z.object({ sessionID: idSchema.optional(), location: z.object({ directory: z.unknown() }).passthrough().optional() }).passthrough().optional(),
  location: z.object({ directory: z.unknown() }).passthrough().optional(),
}).passthrough();
const isRecord = (value) => z.object({}).passthrough().safeParse(value).success;

/**
 * The records of one space's list, kept or dropped one by one. `isHostSessionId` answers the
 * host's ids, `claimedBy` names the space that already listed an id. Duplicates within the list
 * keep the first. Resolves `{ records, dropped }`, `dropped` counting each code.
 */
export function filterSpaceSessionRecords({ spaceId, records, isHostSessionId, claimedBy }) {
  const kept = [];
  const dropped = {};
  const seen = new Set();
  const drop = (code) => { dropped[code] = (dropped[code] ?? 0) + 1; };
  for (const record of records) {
    const parsed = recordSchema.safeParse(record);
    if (!parsed.success) {
      // A record without an id is malformed; one with an id and no usable directory lies outside every root.
      drop(idSchema.safeParse(record?.id).success ? SPACE_DROP_CODES.outsideRoot : SPACE_DROP_CODES.malformed);
      continue;
    }
    const { id, location } = parsed.data;
    if (!isDirectoryOfSpace(location.directory, spaceId)) { drop(SPACE_DROP_CODES.outsideRoot); continue; }
    if (isHostSessionId(id)) { drop(SPACE_DROP_CODES.hostId); continue; }
    const owner = claimedBy(id);
    if (owner !== null && owner !== spaceId) { drop(SPACE_DROP_CODES.claimed); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(sanitizeSessionListItem(record));
  }
  return { records: kept, dropped };
}

/**
 * Whether one event of a space may pass: the session it names is not the host's, and every
 * directory it carries, on the event or on the created session, lies under the space's root.
 * Execution events carry no location and pass on their session id alone. Answers the drop
 * code, or null when the event passes.
 */
export function spaceEventDropCode({ spaceId, payload, isHostSessionId }) {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return SPACE_DROP_CODES.malformed;
  const { data, location } = parsed.data;
  for (const directory of [location?.directory, data?.location?.directory]) {
    if (directory === undefined || directory === null) continue;
    if (!directorySchema.safeParse(directory).success || !isDirectoryOfSpace(directory, spaceId)) return SPACE_DROP_CODES.eventOutsideRoot;
  }
  if (data?.sessionID !== undefined && isHostSessionId(data.sessionID)) return SPACE_DROP_CODES.eventHostSession;
  return null;
}

/**
 * The host's list with every space's records after it. `spaces` marks each space's answer:
 * `complete`, `partial` when the space had more pages than the host read, `stale` when the
 * last known list stands in for an answer that did not come, and `unknown` when the space
 * never answered. A host payload without spaces goes back as it came, untouched.
 */
export function mergeSessionLists(hostPayload, spaceLists) {
  if (spaceLists.length === 0) return hostPayload;
  const records = spaceLists.flatMap((entry) => entry.records);
  // The mark names the space for the client: its label name, the host project it was made for,
  // as the host resolved it from the label, and the project's path inside, or null for both when
  // the project is no longer registered on this host.
  const spaces = spaceLists.map((entry) => ({
    id: entry.spaceId,
    name: entry.name ?? '',
    state: entry.state,
    sessions: entry.records.length,
    projectDirectory: entry.projectDirectory ?? null,
    directory: entry.directory ?? null,
  }));
  if (Array.isArray(hostPayload)) return [...hostPayload, ...records];
  if (isRecord(hostPayload) && Array.isArray(hostPayload.data)) {
    return { ...hostPayload, data: [...hostPayload.data, ...records], spaces };
  }
  return hostPayload;
}

/**
 * What the host knows about sessions across the boundary: the host's own ids, and per space
 * the last list it accepted and the state of that answer. One per host process.
 */
export function createSpaceSessionIndex({ logger = console } = {}) {
  const hostIds = new Map();
  const spaces = new Map();
  const claims = new Map();

  const rememberHostId = (id) => {
    if (!idSchema.safeParse(id).success) return;
    hostIds.delete(id);
    hostIds.set(id, true);
    if (hostIds.size > HOST_ID_MEMORY) hostIds.delete(hostIds.keys().next().value);
  };
  const isHostSessionId = (id) => hostIds.has(id);
  const claimedBy = (id) => claims.get(id) ?? null;

  const logDropped = (spaceId, dropped) => {
    for (const [code, count] of Object.entries(dropped)) {
      logger.warn?.(`[spaces] dropped ${count} record(s) of space ${spaceId}: ${code}`);
    }
  };

  const entryOf = (spaceId) => {
    let entry = spaces.get(spaceId);
    if (!entry) {
      entry = { spaceId, records: [], state: 'unknown' };
      spaces.set(spaceId, entry);
    }
    return entry;
  };

  const releaseClaims = (spaceId) => {
    for (const [id, owner] of claims) if (owner === spaceId) claims.delete(id);
  };

  return {
    isHostSessionId,
    claimedBy,
    /** The host's list passed through the proxy: its ids are the host's from now on. */
    observeHostRecords(records) {
      for (const record of records) if (isRecord(record)) rememberHostId(record.id);
    },
    /** A host event that names a session: a created one is the host's from now on. */
    observeHostEvent(payload) {
      const parsed = eventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.type !== 'session.created') return;
      rememberHostId(parsed.data.data?.sessionID);
    },
    /** A space answered its list, whole or in part. The records that pass replace the last known ones. */
    acceptSpaceList(spaceId, records, { complete }) {
      const filtered = filterSpaceSessionRecords({ spaceId, records, isHostSessionId, claimedBy });
      logDropped(spaceId, filtered.dropped);
      releaseClaims(spaceId);
      for (const record of filtered.records) claims.set(record.id, spaceId);
      const entry = entryOf(spaceId);
      entry.records = filtered.records;
      entry.state = complete ? 'complete' : 'partial';
      return entry;
    },
    /** A space did not answer: its last known list stands, marked stale. */
    markUnreachable(spaceId) {
      const entry = entryOf(spaceId);
      if (entry.state !== 'unknown') entry.state = 'stale';
      return entry;
    },
    /** A space is gone: nothing of it is listed or claimed any more. */
    forget(spaceId) {
      spaces.delete(spaceId);
      releaseClaims(spaceId);
    },
    /** Whether one event of a space passes. A created session that passes is claimed for the space. */
    acceptSpaceEvent(spaceId, payload) {
      const code = spaceEventDropCode({ spaceId, payload, isHostSessionId });
      if (code !== null) {
        logger.warn?.(`[spaces] dropped an event of space ${spaceId}: ${code}`);
        return false;
      }
      const sessionID = payload.data?.sessionID;
      if (idSchema.safeParse(sessionID).success) {
        // A session another space listed or made is that space's: no other space speaks for it.
        const owner = claimedBy(sessionID);
        if (owner !== null && owner !== spaceId) {
          logger.warn?.(`[spaces] dropped an event of space ${spaceId}: ${SPACE_DROP_CODES.claimed}`);
          return false;
        }
        if (payload.type === 'session.created') claims.set(sessionID, spaceId);
      }
      return true;
    },
    /** Every space's last accepted list with its state, for the merge. */
    snapshot() {
      return Array.from(spaces.values(), (entry) => ({ spaceId: entry.spaceId, state: entry.state, records: entry.records }));
    },
  };
}
