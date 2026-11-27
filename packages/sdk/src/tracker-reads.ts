import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import {
  GUEST_TRACKER_CONTAINER_ID_MAX,
  GUEST_TRACKER_CURSOR_MAX,
  GUEST_TRACKER_ID_MAX,
  GUEST_TRACKER_QUERY_MAX,
  GUEST_TRACKER_STATE_MAX,
} from './contract.ts';
import type { GuestMessage, HostResultPayload } from './contract.ts';
import { HostRequestError } from './errors.ts';

export type GuestTrackerProviderId = string;
export type GuestTrackerStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type GuestTrackerPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

export type GuestTrackerPerson = { name: string | null; avatarUrl: string | null };
export type GuestTrackerItemState = { id: string | null; name: string; category: GuestTrackerStateCategory | null };
export type GuestTrackerContainer = { id: string; key: string | null; name: string };
export type GuestTrackerLabel = { id: string; name: string; color: string | null };
export type GuestTrackerProgress = { total: number; done: number; more: boolean };

export type GuestTrackerItemSummary = {
  provider: GuestTrackerProviderId;
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: GuestTrackerItemState | null;
  priority?: GuestTrackerPriority | null;
  labels?: GuestTrackerLabel[];
  assignee?: GuestTrackerPerson | null;
  container?: GuestTrackerContainer | null;
  parent?: GuestTrackerItemSummary | null;
  progress?: GuestTrackerProgress | null;
  updatedAt?: string | null;
};

export type GuestTrackerComment = { id: string; body: string; createdAt: string | null; author: GuestTrackerPerson | null };

export type GuestTrackerItem = GuestTrackerItemSummary & {
  description?: string | null;
  comments?: GuestTrackerComment[];
  children?: GuestTrackerItemSummary[];
  childrenMore?: boolean;
};

export type GuestTrackerPeopleFilter = 'any' | 'me' | 'created';
export type GuestTrackerPriorityFilter = 'all' | GuestTrackerPriority;

export type GuestTrackerListOptions = {
  query?: string;
  cursor?: string;
  state?: string;
  people?: GuestTrackerPeopleFilter;
  priority?: GuestTrackerPriorityFilter;
  containerId?: string | null;
};

export type GuestTrackerFilterOptions = {
  name: string;
  stateFilters: string[];
  people: boolean;
  priority: boolean;
};

export type GuestTrackerListResult =
  | { connected: false }
  | { connected: true; items: GuestTrackerItemSummary[]; cursor: string | null; hasMore: boolean };

export type GuestTrackerItemResult = { connected: false } | { connected: true; item: GuestTrackerItem | null };

export type GuestTrackerRequest =
  | { op: 'list'; options?: GuestTrackerListOptions }
  | { op: 'get'; id: string }
  | { op: 'filters' };

export type GuestTrackerResult =
  | { op: 'list'; result: GuestTrackerListResult }
  | { op: 'get'; result: GuestTrackerItemResult }
  | { op: 'filters'; result: GuestTrackerFilterOptions };

export type GuestTrackerMessage = {
  channel: typeof OPENCHAMBER_SDK_CHANNEL;
  v: typeof OPENCHAMBER_SDK_API_VERSION;
  type: 'tracker';
  id: string;
  payload: GuestTrackerRequest;
};

const isPeopleFilter = (value: string): value is GuestTrackerPeopleFilter => (
  value === 'any' || value === 'me' || value === 'created'
);

const isPriorityFilter = (value: string): value is GuestTrackerPriorityFilter => (
  value === 'all' || value === 'none' || value === 'urgent' || value === 'high' || value === 'medium' || value === 'low'
);

const readTrackerText = (value: string, maximum: number, label: string): string => {
  const text = value.trim();
  if (!text || text.length > maximum) {
    throw new HostRequestError('HOST_REJECTED', `${label} must contain 1 to ${maximum} characters.`);
  }
  return text;
};

const readOptionalText = (value: string | undefined, maximum: number, label: string): string | undefined => (
  value === undefined ? undefined : readTrackerText(value, maximum, label)
);

const clampListOptions = (options: GuestTrackerListOptions): GuestTrackerListOptions => {
  const clamped: GuestTrackerListOptions = {};
  const query = readOptionalText(options.query, GUEST_TRACKER_QUERY_MAX, 'Query');
  if (query !== undefined) clamped.query = query;
  const cursor = readOptionalText(options.cursor, GUEST_TRACKER_CURSOR_MAX, 'Cursor');
  if (cursor !== undefined) clamped.cursor = cursor;
  const state = readOptionalText(options.state, GUEST_TRACKER_STATE_MAX, 'State filter');
  if (state !== undefined) clamped.state = state;
  if (options.people !== undefined) {
    if (!isPeopleFilter(options.people)) throw new HostRequestError('HOST_REJECTED', `Unknown people filter: ${String(options.people)}`);
    clamped.people = options.people;
  }
  if (options.priority !== undefined) {
    if (!isPriorityFilter(options.priority)) throw new HostRequestError('HOST_REJECTED', `Unknown priority filter: ${String(options.priority)}`);
    clamped.priority = options.priority;
  }
  if (options.containerId === null) clamped.containerId = null;
  else if (options.containerId !== undefined) clamped.containerId = readTrackerText(options.containerId, GUEST_TRACKER_CONTAINER_ID_MAX, 'Container id');
  return clamped;
};

export const isGuestTrackerResult = (
  value: HostResultPayload | undefined,
  op?: GuestTrackerRequest['op'],
): value is GuestTrackerResult => {
  if (!value || Object(value) !== value) return false;
  if (!('op' in value) || !('result' in value)) return false;
  const operation = value.op;
  if (operation !== 'list' && operation !== 'get' && operation !== 'filters') return false;
  if (op !== undefined && operation !== op) return false;
  const result = value.result;
  if (!result || Object(result) !== result) return false;
  if (operation === 'filters') return 'stateFilters' in result && Array.isArray(result.stateFilters);
  if (!('connected' in result)) return false;
  if (result.connected === false) return true;
  return operation === 'list'
    ? 'items' in result && Array.isArray(result.items)
    : 'item' in result;
};

export type GuestTrackerClient = {
  list: (options?: GuestTrackerListOptions) => Promise<GuestTrackerListResult>;
  get: (id: string) => Promise<GuestTrackerItemResult>;
  filters: () => Promise<GuestTrackerFilterOptions>;
};

export const createGuestTrackerReadClient = ({
  envelope,
  nextId,
  send,
}: {
  envelope: Pick<GuestMessage, 'channel' | 'v'>;
  nextId: () => string;
  send: (message: GuestTrackerMessage) => Promise<HostResultPayload | undefined>;
}): GuestTrackerClient => {
  const call = async (payload: GuestTrackerRequest): Promise<GuestTrackerResult> => {
    const answer = await send({ ...envelope, type: 'tracker', id: nextId(), payload });
    if (!isGuestTrackerResult(answer, payload.op)) {
      throw new HostRequestError('HOST_REJECTED', 'Host did not return tracker data.');
    }
    return answer;
  };
  return {
    list: async (options = {}) => {
      const answer = await call({ op: 'list', options: clampListOptions(options) });
      if (answer.op !== 'list') throw new HostRequestError('HOST_REJECTED', 'Host did not return tracker items.');
      return answer.result;
    },
    get: async (id) => {
      const answer = await call({ op: 'get', id: readTrackerText(id, GUEST_TRACKER_ID_MAX, 'Item id') });
      if (answer.op !== 'get') throw new HostRequestError('HOST_REJECTED', 'Host did not return the tracker item.');
      return answer.result;
    },
    filters: async () => {
      const answer = await call({ op: 'filters' });
      if (answer.op !== 'filters') throw new HostRequestError('HOST_REJECTED', 'Host did not return tracker filters.');
      return answer.result;
    },
  };
};
