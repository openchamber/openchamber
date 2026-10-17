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
// `session.deleted`) and seeded once from the host. Pages that wait for the
// user's answer have no OpenCode event and no directory store; the server
// announces them (`applyWaitingPageEvent`), and this index is their only home. Nothing streams through
// here, so consumers subscribe per session ID without cost.
//
// Only the fields the consuming surfaces render are kept. The host seed can
// carry no more than this, and storing the full requests would make the two
// feeds disagree on shape for no gain.
export type BlockingPermissionRequest = Pick<PermissionRequest, 'id' | 'sessionID' | 'action' | 'resources' | 'save'>;
export type BlockingFormRequest = Pick<FormRequest, 'id' | 'sessionID' | 'title'>;
/**
 * A page an agent showed that waits for the user's answer (render.page with
 * awaitAnswer). It blocks the agent like a form, so every surface shows it as
 * one, but it is answered on the page in the chat: it is kept apart from
 * forms so nothing tries to answer it as a form. `id` is the tool call id.
 */
type BlockingPageRequest = { id: string; sessionID: string; title: string };

type PendingBlockingRequests = {
  directory: string;
  permissions: readonly BlockingPermissionRequest[];
  forms: readonly BlockingFormRequest[];
  pages: readonly BlockingPageRequest[];
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
const toBlockingPermission = ({ id, sessionID, action, resources, save }: PermissionRequest): BlockingPermissionRequest => (
  { id, sessionID, action, resources, save }
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

type BlockingRequest =
  | { kind: 'permission'; request: BlockingPermissionRequest }
  | { kind: 'form'; request: BlockingFormRequest }
  | { kind: 'page'; request: BlockingPageRequest };

class Reducer {
  private draft: Draft | null = null;

  constructor(private readonly state: GlobalBlockingRequestsState) {}

  current(sessionId: string): PendingBlockingRequests | undefined {
    return (this.draft ?? this.state.bySession).get(sessionId);
  }

  write(sessionId: string, entry: PendingBlockingRequests): void {
    this.draft ??= new Map(this.state.bySession);
    if (entry.permissions.length === 0 && entry.forms.length === 0 && entry.pages.length === 0) this.draft.delete(sessionId);
    else this.draft.set(sessionId, entry);
  }

  ask(directory: string, sessionId: string, request: BlockingRequest): void {
    const existing = this.current(sessionId) ?? { directory, permissions: EMPTY, forms: EMPTY, pages: EMPTY };
    const permissions = request.kind === 'permission' ? upsertRequest(existing.permissions, request.request) : null;
    const forms = request.kind === 'form' ? upsertRequest(existing.forms, request.request) : null;
    const pages = request.kind === 'page' ? upsertRequest(existing.pages, request.request) : null;
    if (!permissions && !forms && !pages && existing.directory === directory) return;
    this.write(sessionId, {
      directory,
      permissions: permissions ?? existing.permissions,
      forms: forms ?? existing.forms,
      pages: pages ?? existing.pages,
    });
  }

  settle(kind: 'permissions' | 'forms' | 'pages', sessionId: string, requestId: string | undefined): void {
    const existing = this.current(sessionId);
    if (!existing) return;
    const remaining = withoutRequest<{ id: string }>(existing[kind], requestId);
    if (remaining) this.write(sessionId, { ...existing, [kind]: remaining });
  }

  remove(sessionId: string): void {
    const existing = this.current(sessionId);
    if (!existing) return;
    this.write(sessionId, { ...existing, permissions: EMPTY, forms: EMPTY, pages: EMPTY });
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
        if (request.sessionID && request.id) reducer.ask(directory, request.sessionID, { kind: 'permission', request: toBlockingPermission(request) });
        continue;
      }
      case 'form.created': {
        const { form } = payload.properties;
        if (form.sessionID && form.id) reducer.ask(directory, form.sessionID, { kind: 'form', request: toBlockingForm(form) });
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
 * Applies the server's announcement that a page an agent showed started or
 * stopped waiting for the user's answer. The server names the session's
 * directory when it knows it; otherwise `resolveDirectory` finds it, and a
 * page whose session this client cannot place is left out until the next
 * seed.
 */
export const applyWaitingPageEvent = (
  event: Extract<SyncEvent, { type: 'openchamber.page-waiting' | 'openchamber.page-settled' }>,
  resolveDirectory: (sessionId: string) => string | null,
): void => {
  const reducer = new Reducer(useGlobalBlockingRequestsStore.getState());
  if (event.type === 'openchamber.page-settled') {
    reducer.settle('pages', event.properties.sessionID, event.properties.pageID);
  } else {
    const { sessionID, page } = event.properties;
    const directory = event.properties.directory ?? resolveDirectory(sessionID);
    if (!directory) return;
    reducer.ask(normalizeDirectory(directory), sessionID, { kind: 'page', request: { id: page.id, sessionID, title: page.title } });
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
    pages?: readonly BlockingPageRequest[];
  }>,
): void => {
  const state = useGlobalBlockingRequestsStore.getState();
  const reducer = new Reducer(state);
  for (const entry of entries) {
    if (state.bySession.has(entry.sessionId)) continue;
    const pages = entry.pages ?? EMPTY;
    if (entry.permissions.length === 0 && entry.forms.length === 0 && pages.length === 0) continue;
    reducer.write(entry.sessionId, {
      directory: normalizeDirectory(entry.directory),
      permissions: entry.permissions,
      forms: entry.forms,
      pages,
    });
  }
  reducer.publish();
};
