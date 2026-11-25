import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';
import { isLead, isListedAsChild, listedSession } from './listed-session.js';
import { isOperatorChildSession, sessionParentId } from '../session-lineage.js';
import type { SessionInfo, SessionListInput } from '@opencode/client';
import type { ControlClient } from './opencode-client.js';
import type { ControlInput, PublicSessionStatus } from './contracts.js';
import type { ListedSession, ListedSessionRecord } from './listed-session.js';
import type { createWorkMembership } from '../session-work/membership.js';
import type { createOpenChamberSessionService } from '../openchamber-sessions/routes.js';

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
type Statuses = Awaited<ReturnType<ControlClient['session']['active']>>;

export const positiveInteger = <Fallback extends number | null>(value: ControlInput['limit'], fallback: Fallback, field: string) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new OpenChamberControlError(`${field} must be a positive integer`, 400);
  }
  return number;
};

interface SessionListingDependencies {
  assertSingleScope: (input: ControlInput) => void;
  resolveReadDirectory: (input: ControlInput, contextDirectory: ControlInput['directory']) => Promise<string | null | undefined>;
  isSessionWorkEnabled: () => Promise<boolean>;
  getClient: (directory?: string | null) => Promise<ControlClient>;
  activeSessions: (client: ControlClient) => Promise<Statuses>;
  asPublicStatus: (statuses: Statuses, sessionID: string | undefined) => Promise<PublicSessionStatus>;
  withArchiveEntry: (session: SessionInfo) => Promise<ListedSessionRecord>;
  isHiddenSession: (id: string | null, record?: ListedSessionRecord) => boolean;
  workMembership: ReturnType<typeof createWorkMembership>;
  assertSessionExists: (client: ControlClient, sessionID: string) => Promise<ListedSessionRecord>;
  sessionService: Pick<ReturnType<typeof createOpenChamberSessionService>, 'archive'>;
}

export const createSessionListing = ({
  assertSingleScope,
  resolveReadDirectory,
  isSessionWorkEnabled,
  getClient,
  activeSessions,
  asPublicStatus,
  withArchiveEntry,
  isHiddenSession,
  workMembership,
  assertSessionExists,
  sessionService,
}: SessionListingDependencies) => {
  const FILTERED_PAGE_SIZE = 200;

  const listSessions = async (input: ControlInput, contextDirectory: ControlInput['directory'], contextSessionId: string | undefined) => {
    assertSingleScope(input);
    const inWork = input.inWork === true;
    const busy = input.busy === true;
    const mine = input.mine === true;
    const leads = input.leads === true;
    const owner = asNonEmptyString(contextSessionId);
    if (mine && !owner) throw new OpenChamberControlError('mine lists the sessions the calling session created, so it needs a calling session', 400);
    const terms = (asNonEmptyString(input.query) ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const scoped = Boolean(asNonEmptyString(input.projectId) || asNonEmptyString(input.directory));
    const filtered = inWork || busy || leads || mine;
    const everywhere = filtered && !scoped;
    const directory = everywhere ? null : await resolveReadDirectory(input, contextDirectory);
    const limit = positiveInteger(input.limit, filtered ? null : 10, 'limit');
    const workEnabled = await isSessionWorkEnabled();
    if (inWork && !workEnabled) throw new OpenChamberControlError('In work is turned off in Settings', 409);

    const client = await getClient(directory ?? '');
    const wantStatus = busy || mine || input.withStatus === true;
    const statuses = wantStatus ? await activeSessions(client).catch(() => null) : null;
    if (busy && !statuses) throw new OpenChamberControlError('Could not read which sessions are running', 503);
    const runningCount = busy ? Object.keys(statuses ?? {}).length : 0;

    const collected: ListedSession[] = [];
    const full = () => limit !== null && collected.length >= limit;
    const seenCursors = new Set();
    const seenSessionIds = new Set();
    let runningSeen = 0;
    let cursor;
    while (!(busy && runningSeen >= runningCount)) {
      const listInput: Mutable<SessionListInput> = {};
      if (directory) listInput.directory = directory;
      if (input.children !== true) listInput.parentID = null;
      if (filtered || terms.length > 0) listInput.limit = FILTERED_PAGE_SIZE;
      if (cursor) listInput.cursor = cursor;
      const response = await client.session.list(listInput);
      const page = await Promise.all((Array.isArray(response?.data) ? response.data : []).map(withArchiveEntry));
      for (const record of page) {
        const id = asNonEmptyString(record?.id);
        if (isHiddenSession(id, record)) continue;
        if (mine && !(isOperatorChildSession(record) && sessionParentId(record) === owner)) continue;
        if (!mine && input.children !== true && isListedAsChild(record)) continue;
        if (id) {
          if (seenSessionIds.has(id)) continue;
          seenSessionIds.add(id);
        }
        const running = Boolean(id && statuses?.[id]);
        if (running) runningSeen += 1;
        if (input.all !== true && record?.time?.archived) continue;
        if (busy && !running) continue;
        if (leads && !isLead(record)) continue;
        if (terms.length > 0) {
          const title = (asNonEmptyString(record?.title) ?? '').toLowerCase();
          if (!terms.every((term) => title.includes(term))) continue;
        }
        const session = listedSession(record, workEnabled ? workMembership : null);
        if (inWork && !session.inWork) continue;
        collected.push(session);
        if (full()) break;
      }
      if (full()) break;
      const next = asNonEmptyString(response?.cursor?.next);
      if (!next || page.length === 0 || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }

    const sessions = wantStatus
      ? await Promise.all(collected.map(async (session) => ({
        ...session,
        status: statuses ? await asPublicStatus(statuses, session.id) : { type: 'unknown' },
      })))
      : collected;
    return { sessions, limit, directory, archived: input.all === true ? 'included' : 'excluded' };
  };

  const archiveOwnSession = async (input: ControlInput, contextSessionId: string | undefined) => {
    const owner = asNonEmptyString(contextSessionId);
    if (!owner) throw new OpenChamberControlError('session.archive needs a calling session', 400);
    const sessionID = asNonEmptyString(input.sessionId);
    if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
    const session = await assertSessionExists(await getClient(), sessionID);
    if (!(isOperatorChildSession(session) && sessionParentId(session) === owner)) {
      throw new OpenChamberControlError(`${sessionID} is not a session you created with ownWork; only those can be archived here`, 403);
    }
    const { failedIds } = await sessionService.archive({ ids: [sessionID] });
    if (failedIds.length > 0) throw new OpenChamberControlError(`Could not archive ${sessionID}`, 502);
    return { sessionId: sessionID, archived: true };
  };

  return { listSessions, archiveOwnSession };
};
