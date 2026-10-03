import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';
import { normalizeProjectPath } from '@/lib/projectResolution';
import type { FormRequest, PermissionRequest } from '@/lib/opencode/model';

// Cross-directory index of permission requests and forms still waiting for an
// answer. Directory stores remain the source for open directories; this index
// exists for the ones that are never bootstrapped, whose pending requests
// would otherwise be invisible to the tray and to any surface that does not
// mount a row for them.
//
// It is fed by the same rare events the directory reducer consumes
// (`permission.asked`/`permission.replied`, `form.created`/`form.settled`,
// `session.deleted`) and seeded once from the host. Nothing streams through
// here, so consumers subscribe per session ID without cost.
//
// Only the fields the consuming surfaces render are kept. The host seed can
// carry no more than this, and storing the full requests would make the two
// feeds disagree on shape for no gain.
export type BlockingPermissionRequest = Pick<PermissionRequest, 'id' | 'sessionID' | 'action' | 'resources'>;
export type BlockingFormRequest = Pick<FormRequest, 'id' | 'sessionID' | 'title'>;

export type PendingBlockingRequests = {
  directory: string;
  permissions: readonly BlockingPermissionRequest[];
  forms: readonly BlockingFormRequest[];
};

type GlobalBlockingRequestsState = {
  bySession: ReadonlyMap<string, PendingBlockingRequests>;
};

const EMPTY: readonly never[] = [];

export const useGlobalBlockingRequestsStore = create<GlobalBlockingRequestsState>(() => ({
  bySession: new Map(),
}));

export const resetGlobalBlockingRequests = (): void => {
  useGlobalBlockingRequestsStore.setState({ bySession: new Map() });
};

const normalizeDirectory = (directory: string): string => normalizeProjectPath(directory) ?? directory;

// The live events carry the whole request; only the rendered fields are kept,
// so the index holds the same shape the host seed can provide and a long-lived
// global map never retains a form's full field definitions.
const toBlockingPermission = ({ id, sessionID, action, resources }: PermissionRequest): BlockingPermissionRequest => (
  { id, sessionID, action, resources }
);
const toBlockingForm = ({ id, sessionID, title }: FormRequest): BlockingFormRequest => ({ id, sessionID, title });

/**
 * Returns the list with the request added or replaced, or null when nothing
 * changed. OpenCode re-sends an unanswered ask, and the projection above makes
 * a fresh object every time, so equality is by value: an identical repeat must
 * not publish a new store snapshot to every subscriber.
 */
const upsertRequest = <T extends { id: string }>(list: readonly T[], request: T): readonly T[] | null => {
  const index = list.findIndex((entry) => entry.id === request.id);
  if (index === -1) return [...list, request];
  if (JSON.stringify(list[index]) === JSON.stringify(request)) return null;
  const next = [...list];
  next[index] = request;
  return next;
};

/** Returns the list without the request, or null when nothing changed. A missing id settles the whole kind. */
const withoutRequest = <T extends { id: string }>(list: readonly T[], requestId: string | undefined): readonly T[] | null => {
  if (!requestId) return list.length === 0 ? null : EMPTY;
  const next = list.filter((entry) => entry.id !== requestId);
  return next.length === list.length ? null : next;
};

type Draft = Map<string, PendingBlockingRequests>;

class Reducer {
  private draft: Draft | null = null;

  constructor(private readonly state: GlobalBlockingRequestsState) {}

  current(sessionId: string): PendingBlockingRequests | undefined {
    return (this.draft ?? this.state.bySession).get(sessionId);
  }

  write(sessionId: string, entry: PendingBlockingRequests): void {
    this.draft ??= new Map(this.state.bySession);
    if (entry.permissions.length === 0 && entry.forms.length === 0) this.draft.delete(sessionId);
    else this.draft.set(sessionId, entry);
  }

  ask(directory: string, sessionId: string, request: BlockingPermissionRequest | null, form: BlockingFormRequest | null): void {
    const existing = this.current(sessionId) ?? { directory, permissions: EMPTY, forms: EMPTY };
    const permissions = request ? upsertRequest(existing.permissions, request) : null;
    const forms = form ? upsertRequest(existing.forms, form) : null;
    if (!permissions && !forms && existing.directory === directory) return;
    this.write(sessionId, {
      directory,
      permissions: permissions ?? existing.permissions,
      forms: forms ?? existing.forms,
    });
  }

  settle(kind: 'permissions' | 'forms', sessionId: string, requestId: string | undefined): void {
    const existing = this.current(sessionId);
    if (!existing) return;
    if (kind === 'permissions') {
      const permissions = withoutRequest(existing.permissions, requestId);
      if (permissions) this.write(sessionId, { ...existing, permissions });
      return;
    }
    const forms = withoutRequest(existing.forms, requestId);
    if (forms) this.write(sessionId, { ...existing, forms });
  }

  remove(sessionId: string): void {
    const existing = this.current(sessionId);
    if (!existing) return;
    this.write(sessionId, { ...existing, permissions: EMPTY, forms: EMPTY });
  }

  publish(): void {
    if (this.draft) useGlobalBlockingRequestsStore.setState({ bySession: this.draft });
  }
}

/** Applies request lifecycle events for one directory. Other event types are ignored cheaply. */
export const applyGlobalBlockingRequestEvents = (rawDirectory: string, payloads: readonly SyncEvent[]): void => {
  if (payloads.length === 0) return;
  const directory = normalizeDirectory(rawDirectory);
  const reducer = new Reducer(useGlobalBlockingRequestsStore.getState());

  for (const payload of payloads) {
    switch (payload.type) {
      case 'permission.asked': {
        const request = payload.properties;
        if (request.sessionID && request.id) reducer.ask(directory, request.sessionID, toBlockingPermission(request), null);
        continue;
      }
      case 'form.created': {
        const { form } = payload.properties;
        if (form.sessionID && form.id) reducer.ask(directory, form.sessionID, null, toBlockingForm(form));
        continue;
      }
      case 'permission.replied': {
        const { sessionID, requestID } = payload.properties;
        if (sessionID) reducer.settle('permissions', sessionID, requestID);
        continue;
      }
      case 'form.settled': {
        const { sessionID, formID } = payload.properties;
        if (sessionID) reducer.settle('forms', sessionID, formID);
        continue;
      }
      case 'session.deleted': {
        const { sessionID } = payload.properties;
        if (sessionID) reducer.remove(sessionID);
        continue;
      }
      default:
        continue;
    }
  }

  reducer.publish();
};

/**
 * Seeds requests the host still holds for sessions this client has no entry
 * for. Additive by session; absence from the host never clears anything,
 * because a live reply may already have settled a request the host map lags on.
 */
export const seedGlobalBlockingRequests = (
  entries: ReadonlyArray<{
    sessionId: string;
    directory: string;
    permissions: readonly BlockingPermissionRequest[];
    forms: readonly BlockingFormRequest[];
  }>,
): void => {
  const state = useGlobalBlockingRequestsStore.getState();
  const reducer = new Reducer(state);
  for (const entry of entries) {
    if (state.bySession.has(entry.sessionId)) continue;
    if (entry.permissions.length === 0 && entry.forms.length === 0) continue;
    reducer.write(entry.sessionId, {
      directory: normalizeDirectory(entry.directory),
      permissions: entry.permissions,
      forms: entry.forms,
    });
  }
  reducer.publish();
};
