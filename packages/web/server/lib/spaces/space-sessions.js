
import { z } from 'zod';

import { sanitizeSessionListItem } from '../opencode/proxy.js';
import { isDirectoryOfSpace } from './dispatcher.js';
import { SPACE_HOME } from './layout.js';

const HOST_ID_MEMORY = 50_000;

export const SPACE_DROP_CODES = Object.freeze({
  malformed: 'space_session_malformed',
  outsideRoot: 'space_session_outside_root',
  hostId: 'space_session_host_id',
  claimed: 'space_session_claimed',
  eventHostSession: 'space_event_host_session',
  eventOutsideRoot: 'space_event_outside_root',
});

const directorySchema = z.string().min(1);
const idSchema = z.string().min(1);
const recordSchema = z.object({ id: idSchema, location: z.object({ directory: directorySchema }).passthrough() }).passthrough();
const eventSchema = z.object({
  type: z.string(),
  data: z.object({ sessionID: idSchema.optional(), location: z.object({ directory: z.unknown() }).passthrough().optional() }).passthrough().optional(),
  location: z.object({ directory: z.unknown() }).passthrough().optional(),
}).passthrough();
const isRecord = (value) => z.object({}).passthrough().safeParse(value).success;

export function filterSpaceSessionRecords({ spaceId, records, isHostSessionId, claimedBy }) {
  const kept = [];
  const dropped = {};
  const seen = new Set();
  const drop = (code) => { dropped[code] = (dropped[code] ?? 0) + 1; };
  for (const record of records) {
    const parsed = recordSchema.safeParse(record);
    if (!parsed.success) {
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

const isUnderSpaceHome = (directory) => {
  const parsed = directorySchema.safeParse(directory);
  return parsed.success && (parsed.data === SPACE_HOME || parsed.data.startsWith(`${SPACE_HOME}/`));
};

const isSpaceHomeEvent = (payload) => {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) return false;
  const { data, location } = parsed.data;
  const directories = [location?.directory, data?.location?.directory].filter((directory) => directory !== undefined && directory !== null);
  return directories.length > 0 && directories.every(isUnderSpaceHome);
};

export function mergeSessionLists(hostPayload, spaceLists) {
  if (spaceLists.length === 0) return hostPayload;
  const records = spaceLists.flatMap((entry) => entry.records);
  const spaces = spaceLists.map((entry) => ({
    id: entry.spaceId,
    name: entry.name ?? '',
    taskTitle: entry.taskTitle ?? null,
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
    observeHostRecords(records) {
      for (const record of records) if (isRecord(record)) rememberHostId(record.id);
    },
    observeHostEvent(payload) {
      const parsed = eventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.type !== 'session.created') return;
      rememberHostId(parsed.data.data?.sessionID);
    },
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
    markUnreachable(spaceId) {
      const entry = entryOf(spaceId);
      if (entry.state !== 'unknown') entry.state = 'stale';
      return entry;
    },
    forget(spaceId) {
      spaces.delete(spaceId);
      releaseClaims(spaceId);
    },
    acceptSpaceEvent(spaceId, payload) {
      const code = spaceEventDropCode({ spaceId, payload, isHostSessionId });
      if (code !== null) {
        if (!(code === SPACE_DROP_CODES.eventOutsideRoot && isSpaceHomeEvent(payload))) {
          logger.warn?.(`[spaces] dropped an event of space ${spaceId}: ${code}`);
        }
        return false;
      }
      const sessionID = payload.data?.sessionID;
      if (idSchema.safeParse(sessionID).success) {
        const owner = claimedBy(sessionID);
        if (owner !== null && owner !== spaceId) {
          logger.warn?.(`[spaces] dropped an event of space ${spaceId}: ${SPACE_DROP_CODES.claimed}`);
          return false;
        }
        if (payload.type === 'session.created') claims.set(sessionID, spaceId);
      }
      return true;
    },
    spaceSessionDropCode(spaceId, sessionId, directory = null) {
      if (directory !== null && (!directorySchema.safeParse(directory).success || !isDirectoryOfSpace(directory, spaceId))) return SPACE_DROP_CODES.eventOutsideRoot;
      if (!idSchema.safeParse(sessionId).success) return SPACE_DROP_CODES.malformed;
      if (isHostSessionId(sessionId)) return SPACE_DROP_CODES.eventHostSession;
      if ((claimedBy(sessionId) ?? spaceId) !== spaceId) return SPACE_DROP_CODES.claimed;
      return null;
    },
    snapshot() {
      return Array.from(spaces.values(), (entry) => ({ spaceId: entry.spaceId, state: entry.state, records: entry.records }));
    },
  };
}
