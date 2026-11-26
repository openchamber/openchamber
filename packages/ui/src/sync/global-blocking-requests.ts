import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';
import { normalizeProjectPath } from '@/lib/projectResolution';
import type { FormRequest, PermissionRequest } from '@/lib/opencode/model';
import type { HostSessionStatusSnapshot } from '@/lib/opencode/session-status';
import { isSpaceDirectory } from '@/lib/spaces/space-route';

export type BlockingPermissionRequest = Pick<PermissionRequest, 'id' | 'sessionID' | 'action' | 'resources' | 'save'>;
export type BlockingFormRequest = Pick<FormRequest, 'id' | 'sessionID' | 'title'>;
type BlockingPageRequest = { id: string; sessionID: string; title: string };

export type PendingBlockingRequests = {
  directory: string;
  permissions: readonly BlockingPermissionRequest[];
  forms: readonly BlockingFormRequest[];
  pages: readonly BlockingPageRequest[];
};

type GlobalBlockingRequestsState = {
  bySession: ReadonlyMap<string, PendingBlockingRequests>;
};

export type BlockingRequestKinds = { hasPermission: boolean; hasForm: boolean };

const NOTHING_PENDING: BlockingRequestKinds = { hasPermission: false, hasForm: false };
const PERMISSION_PENDING: BlockingRequestKinds = { hasPermission: true, hasForm: false };
const FORM_PENDING: BlockingRequestKinds = { hasPermission: false, hasForm: true };
const PERMISSION_AND_FORM_PENDING: BlockingRequestKinds = { hasPermission: true, hasForm: true };

export const selectIndexedBlockingRequests = (
  bySession: GlobalBlockingRequestsState['bySession'],
  sessionIDs: readonly string[],
): BlockingRequestKinds => {
  let hasPermission = false;
  let hasForm = false;
  for (const sessionID of sessionIDs) {
    const pending = bySession.get(sessionID);
    if (!pending) continue;
    hasPermission ||= pending.permissions.length > 0;
    hasForm ||= pending.forms.length > 0 || pending.pages.length > 0;
  }
  if (hasPermission) return hasForm ? PERMISSION_AND_FORM_PENDING : PERMISSION_PENDING;
  return hasForm ? FORM_PENDING : NOTHING_PENDING;
};

const EMPTY: readonly never[] = [];
type WaitingPageEvent = Extract<SyncEvent, { type: 'openchamber.page-waiting' | 'openchamber.page-settled' | 'session.deleted' }>;
const settledByRead = new Set<string>();
const settledKey = (kind: 'permissions' | 'forms', sessionId: string, requestId: string): string => `${kind}:${sessionId}:${requestId}`;
const pageSnapshotObservers = new Set<(event: WaitingPageEvent) => void>();

const recordWaitingPageEvent = (event: WaitingPageEvent): void => {
  for (const observer of pageSnapshotObservers) observer(event);
};

export const useGlobalBlockingRequestsStore = create<GlobalBlockingRequestsState>(() => ({
  bySession: new Map(),
}));

export const useIsPageWaiting = (sessionId: string | null | undefined): boolean => (
  useGlobalBlockingRequestsStore((state) => Boolean(sessionId && state.bySession.get(sessionId)?.pages.length))
);

export const useIsCallWaiting = (sessionId: string | null | undefined, callId: string | null | undefined): boolean => (
  useGlobalBlockingRequestsStore((state) => Boolean(sessionId && callId && state.bySession.get(sessionId)?.pages.some((page) => page.id === callId)))
);

export const settledPageKeys = (
  previous: ReadonlyMap<string, PendingBlockingRequests>,
  next: ReadonlyMap<string, PendingBlockingRequests>,
): string[] => {
  const settled: string[] = [];
  for (const [sessionId, entry] of previous) {
    if (entry.pages.length === 0) continue;
    const remaining = next.get(sessionId)?.pages;
    if (remaining === entry.pages) continue;
    const kept = new Set(remaining?.map((page) => page.id));
    for (const page of entry.pages) if (!kept.has(page.id)) settled.push(`${sessionId}:${page.id}`);
  }
  return settled;
};

export const resetGlobalBlockingRequests = (): void => {
  pageSnapshotObservers.clear();
  settledByRead.clear();
  useGlobalBlockingRequestsStore.setState({ bySession: new Map() });
};

const normalizeDirectory = (directory: string): string => normalizeProjectPath(directory) ?? directory;

const toBlockingPermission = ({ id, sessionID, action, resources, save }: PermissionRequest): BlockingPermissionRequest => (
  { id, sessionID, action, resources, save }
);
const toBlockingForm = ({ id, sessionID, title }: FormRequest): BlockingFormRequest => ({ id, sessionID, title });

const upsertRequest = <T extends { id: string }>(list: readonly T[], request: T): readonly T[] | null => {
  const index = list.findIndex((entry) => entry.id === request.id);
  if (index === -1) return [...list, request];
  if (JSON.stringify(list[index]) === JSON.stringify(request)) return null;
  const next = [...list];
  next[index] = request;
  return next;
};

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
        recordWaitingPageEvent(payload);
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

export const indexedBlockingRequestDirectories = (): Set<string> => new Set(
  [...useGlobalBlockingRequestsStore.getState().bySession.values()]
    .filter((entry) => entry.permissions.length > 0 || entry.forms.length > 0)
    .map((entry) => entry.directory),
);

export const indexedBlockingRequestSessionIds = (rawDirectory: string): string[] => {
  const directory = normalizeDirectory(rawDirectory);
  return [...useGlobalBlockingRequestsStore.getState().bySession]
    .filter(([, entry]) => entry.directory === directory && (entry.permissions.length > 0 || entry.forms.length > 0))
    .map(([sessionId]) => sessionId);
};

export const settleAbsentBlockingRequests = (
  rawDirectory: string,
  kind: 'permissions' | 'forms',
  sessionIds: readonly string[],
  indexedBeforeRead: GlobalBlockingRequestsState['bySession'],
  live: Readonly<Record<string, readonly { id: string }[]>>,
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const reducer = new Reducer(useGlobalBlockingRequestsStore.getState());
  for (const sessionId of sessionIds) {
    const indexed = indexedBeforeRead.get(sessionId);
    if (indexed?.directory !== directory) continue;
    for (const request of indexed[kind]) {
      if (live[sessionId]?.some((entry) => entry.id === request.id)) continue;
      settledByRead.add(settledKey(kind, sessionId, request.id));
      reducer.settle(kind, sessionId, request.id);
    }
  }
  reducer.publish();
};

export const applyWaitingPageEvent = (
  event: Extract<SyncEvent, { type: 'openchamber.page-waiting' | 'openchamber.page-settled' }>,
  resolveDirectory: (sessionId: string) => string | null,
): void => {
  recordWaitingPageEvent(event);
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

export const readHostBlockingRequestsSnapshot = async (
  read: () => Promise<HostSessionStatusSnapshot | null>,
  resolveDirectory: (sessionId: string) => string | null,
): Promise<HostSessionStatusSnapshot | null> => {
  const changes = new Map<string, Map<string, BlockingPageRequest | null> | null>();
  const observe = (event: WaitingPageEvent): void => {
    const sessionId = event.properties.sessionID;
    if (event.type === 'session.deleted') {
      changes.set(sessionId, null);
      return;
    }
    const pages = changes.get(sessionId) ?? new Map<string, BlockingPageRequest | null>();
    if (event.type === 'openchamber.page-settled') pages.set(event.properties.pageID, null);
    else pages.set(event.properties.page.id, { id: event.properties.page.id, sessionID: sessionId, title: event.properties.page.title });
    changes.set(sessionId, pages);
  };
  pageSnapshotObservers.add(observe);
  try {
    const snapshot = await read();
    if (!snapshot || !pageSnapshotObservers.has(observe)) return null;
    if (!snapshot.pending) return snapshot;
    const pending = snapshot.pending;
    const state = useGlobalBlockingRequestsStore.getState();
    const reducer = new Reducer(state);
    const sessionIds = new Set([...state.bySession.keys(), ...Object.keys(pending), ...changes.keys()]);
    for (const sessionId of sessionIds) {
      if (changes.get(sessionId) === null) continue;
      const current = state.bySession.get(sessionId);
      const directory = current?.directory ?? resolveDirectory(sessionId);
      if (!directory || isSpaceDirectory(directory)) continue;
      const entry = pending[sessionId];
      const pagesById = new Map((entry?.pages ?? EMPTY).map(page => [page.id, page]));
      for (const [id, page] of changes.get(sessionId) ?? []) {
        if (page) pagesById.set(id, page);
        else pagesById.delete(id);
      }
      const pages = [...pagesById.values()];
      if (current && JSON.stringify(current.pages) === JSON.stringify(pages)) continue;
      const permissions = current?.permissions ?? entry?.permissions.filter(({ id }) => !settledByRead.has(settledKey('permissions', sessionId, id))) ?? EMPTY;
      const forms = current?.forms ?? entry?.forms.filter(({ id }) => !settledByRead.has(settledKey('forms', sessionId, id))) ?? EMPTY;
      if (!current && permissions.length === 0 && forms.length === 0 && pages.length === 0) continue;
      reducer.write(sessionId, { directory: normalizeDirectory(directory), permissions, forms, pages });
    }
    reducer.publish();
    return snapshot;
  } finally {
    pageSnapshotObservers.delete(observe);
  }
};
