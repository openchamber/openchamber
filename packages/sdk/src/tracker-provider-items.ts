export const TRACKER_PROVIDER_FIELDS_MAX = 20;
export const TRACKER_PROVIDER_FIELD_LABEL_MAX = 128;
export const TRACKER_PROVIDER_FIELD_VALUE_MAX = 1_024;

export type TrackerProviderStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerProviderPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';
export type TrackerProviderPerson = { name: string | null; avatarUrl: string | null };
export type TrackerProviderItemState = { id: string | null; name: string; category: TrackerProviderStateCategory | null };
export type TrackerProviderContainer = { id: string; key: string | null; name: string };
export type TrackerProviderLabel = { id: string; name: string; color: string | null };
export type TrackerProviderField = { id: string; label: string; value: string };
export type TrackerProviderProgress = { total: number; done: number; more: boolean };

export type TrackerProviderItemSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: TrackerProviderItemState | null;
  priority?: TrackerProviderPriority | null;
  labels?: TrackerProviderLabel[];
  fields?: TrackerProviderField[];
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
