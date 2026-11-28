import type { SourceControlJson, SourceControlJsonObject, SourceControlProviderError, TRACKER_PROVIDER_WIRE_VERSION, TrackerProviderMethod } from './service-providers.ts';

export type TrackerProviderStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerProviderPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';
export type TrackerProviderPerson = { name: string | null; avatarUrl: string | null };
export type TrackerProviderItemState = { id: string | null; name: string; category: TrackerProviderStateCategory | null };
export type TrackerProviderContainer = { id: string; key: string | null; name: string };
export type TrackerProviderLabel = { id: string; name: string; color: string | null };
export type TrackerProviderProgress = { total: number; done: number; more: boolean };

export type TrackerProviderItemSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: TrackerProviderItemState | null;
  priority?: TrackerProviderPriority | null;
  labels?: TrackerProviderLabel[];
  assignee?: TrackerProviderPerson | null;
  container?: TrackerProviderContainer | null;
  parent?: TrackerProviderItemSummary | null;
  progress?: TrackerProviderProgress | null;
  updatedAt?: string | null;
};

export type TrackerProviderComment = { id: string; body: string; createdAt: string | null; author: TrackerProviderPerson | null };

export type TrackerProviderItem = TrackerProviderItemSummary & {
  description?: string | null;
  comments?: TrackerProviderComment[];
  children?: TrackerProviderItemSummary[];
  childrenMore?: boolean;
};

export type TrackerProviderWorkflowState = { id: string; name: string; category: TrackerProviderStateCategory | null; position: number };
export type TrackerProviderLiveSummary = { identifier: string; title: string; state: { name: string; category: TrackerProviderStateCategory } };

export type TrackerProviderAccount = { id: string; login: string | null };
export type TrackerProviderSavedFilter = { id: string; name: string };

export type TrackerProviderSession = {
  instance: string;
  handle: string;
  account: TrackerProviderAccount | null;
};

export type TrackerProviderInputs = {
  'auth.probe': Record<string, never>;
  'auth.verify': Record<string, never>;
  'items.list': {
    query?: string;
    cursor?: string;
    state: string;
    people: 'any' | 'me' | 'created';
    priority: 'all' | TrackerProviderPriority;
    containerId: string | null;
    savedFilter?: string | null;
  };
  'items.get': { id: string };
  'items.updateState': { id: string; stateId: string };
  'items.liveSummaries': { identifiers: string[] };
  'states.list': { containerId: string };
  'containers.list': Record<string, never>;
  'filters.list': Record<string, never>;
  'comments.create': { identifier: string; body: string };
};

export type TrackerProviderRequest = {
  v: typeof TRACKER_PROVIDER_WIRE_VERSION;
  requestId: string;
  method: TrackerProviderMethod;
  provider: string;
  session: TrackerProviderSession;
  input: SourceControlJsonObject;
};

export type TrackerProviderAccountData = { account: { id: string; login: string | null; name?: string; avatarUrl?: string } };
export type TrackerProviderProbeData = { supported: boolean; message?: string };
export type TrackerProviderListData = { items: TrackerProviderItemSummary[]; cursor: string | null; hasMore: boolean };
export type TrackerProviderItemData = { item: TrackerProviderItem | null };
export type TrackerProviderStatesData = { states: TrackerProviderWorkflowState[] };
export type TrackerProviderLiveSummariesData = { items: TrackerProviderLiveSummary[] };
export type TrackerProviderContainersData = { containers: TrackerProviderContainer[] };
export type TrackerProviderSavedFiltersData = { filters: TrackerProviderSavedFilter[] };
export type TrackerProviderCommentData = { comment: { id: string } | null };

export type TrackerProviderDataByMethod = {
  'auth.probe': TrackerProviderProbeData;
  'auth.verify': TrackerProviderAccountData;
  'items.list': TrackerProviderListData;
  'items.get': TrackerProviderItemData;
  'items.updateState': TrackerProviderItemData;
  'items.liveSummaries': TrackerProviderLiveSummariesData;
  'states.list': TrackerProviderStatesData;
  'containers.list': TrackerProviderContainersData;
  'filters.list': TrackerProviderSavedFiltersData;
  'comments.create': TrackerProviderCommentData;
};

export type TrackerProviderError = SourceControlProviderError;
export type TrackerProviderResult =
  | { ok: true; data: SourceControlJson }
  | { ok: false; error: TrackerProviderError };
