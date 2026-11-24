import type { TrackerLiveSummaryWire, TrackerRegistry } from '../trackers/tracker-contract.js';

export type ThreadRef = {
  owner: string;
  repo: string;
  number: number;
};

export type PullThreadRef = ThreadRef & { queueRemoval?: boolean };

export interface TrackedThread extends ThreadRef {
  provider: string;
  instance?: string | undefined;
  kind: 'pull' | 'issue' | 'discussion';
  accountId?: string;
}

export interface TrackedWorkItem {
  provider: string;
  kind: 'work-item';
  identifier: string;
}

export type TrackedItem = TrackedThread | TrackedWorkItem;

export interface TrackedItemInput {
  provider?: unknown;
  kind?: unknown;
  identifier?: unknown;
  owner?: unknown;
  repo?: unknown;
  number?: unknown;
  accountId?: unknown;
  instance?: unknown;
}

export interface CachedTrackedState {
  state?: unknown;
  checks?: unknown;
}

export interface TrackedItemState {
  item: TrackedItem;
  state: CachedTrackedState | null;
  fetchedAt: number;
}

export interface PublicTrackedItemState extends TrackedItemState {
  key: string;
}

export interface ServerTrackedItemState extends PublicTrackedItemState {
  requestedAt: number;
}

export interface TrackedItemsPersistence {
  load(): Promise<TrackedItemState[]>;
  save(items: PublicTrackedItemState[]): Promise<void>;
}

export interface SourceControlReadInput {
  provider: string;
  instance?: string;
  accountId?: string | null;
  pulls: PullThreadRef[];
  issues: ThreadRef[];
  discussions?: ThreadRef[];
  details?: boolean;
}

export interface WorkItemsReadInput {
  provider: string;
  identifiers: string[];
}

export type ThreadSummary = ThreadRef & {
  title: string;
  state: string;
};

export interface ReadFailure {
  status: 'disconnected' | 'unavailable';
  retryAfterMs?: number;
}

export interface SourceControlReadSuccess {
  status: 'ok';
  pulls: ThreadSummary[];
  issues: ThreadSummary[];
  discussions: ThreadSummary[];
}

export interface WorkItemsReadSuccess {
  status: 'ok';
  items: TrackerLiveSummaryWire[];
}

export type TrackedItemsReadResult = ReadFailure | {
  status: 'ok';
  pulls?: ThreadSummary[];
  issues?: ThreadSummary[];
  discussions?: ThreadSummary[];
  items?: TrackerLiveSummaryWire[];
};

export interface TrackedItemReaders {
  sourceControl(input: SourceControlReadInput): Promise<ReadFailure | SourceControlReadSuccess>;
  workItems(input: WorkItemsReadInput): Promise<ReadFailure | WorkItemsReadSuccess>;
}

export interface LiveSummariesResult {
  connected: boolean;
  status?: string;
  retryAfterMs?: number;
  summaries?: ThreadSummary[];
  issueSummaries?: ThreadSummary[];
  discussionSummaries?: ThreadSummary[];
}

export interface TrackedItemReaderOptions {
  readLiveSummaries?: (input: {
    provider: string;
    instance: string | undefined;
    accountId: string | null;
    refs: PullThreadRef[];
    issueRefs: ThreadRef[];
    discussionRefs: ThreadRef[];
    details: boolean;
  }) => Promise<LiveSummariesResult>;
  trackers?: Pick<TrackerRegistry, 'implementation'>;
}

export interface TrackedItemsServiceOptions {
  readers: TrackedItemReaders;
  send(connectionId: string, event: {
    type: 'openchamber:tracked-items.changed';
    properties: { states: PublicTrackedItemState[] };
  }): boolean;
  isConnectionOpen(connectionId: string): boolean;
  persistence?: TrackedItemsPersistence | null;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?: { warn?: (...data: unknown[]) => void };
}

export interface TrackedItemRefresh {
  owner?: string;
  repo?: string;
  number?: number;
  identifier?: string;
}
