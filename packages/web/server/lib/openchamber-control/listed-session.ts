import { asNonEmptyString } from '../shared/guards.js';
import { sessionParentId } from '../session-lineage.js';
import type { createWorkMembership, WorkSession } from '../session-work/membership.js';

export interface ListedSessionRecord extends WorkSession {
  id: string;
  title?: unknown;
  time?: WorkSession['time'] & { updated?: number };
  agent?: unknown;
  model?: unknown;
  outcome?: unknown;
}

export interface ListedSession {
  id?: string;
  title?: string;
  directory?: string;
  updated?: number;
  archived?: number;
  parentID?: string;
  agent?: string;
  model?: unknown;
  outcome?: unknown;
  inWork?: boolean;
  doneSuggested?: boolean;
}

interface SessionProjection {
  id: string;
  title: string | null;
  directory: string | null;
  updated: number | undefined;
  archived: number | undefined;
  parentID: string | null;
  agent: string | null;
  model: unknown;
  outcome: unknown;
  inWork?: boolean;
  doneSuggested?: boolean;
}

export const listedSession = (record: ListedSessionRecord, workMembership: Pick<ReturnType<typeof createWorkMembership>, 'isInWork' | 'isDoneSuggested'> | null): ListedSession => {
  const session: SessionProjection = {
    id: record.id,
    title: asNonEmptyString(record.title),
    directory: asNonEmptyString(record.location?.directory) ?? asNonEmptyString(record.directory),
    updated: record.time?.updated,
    archived: record.time?.archived,
    parentID: sessionParentId(record),
    agent: asNonEmptyString(record.agent),
    model: record.model,
    outcome: record.outcome,
  };
  if (workMembership) {
    session.inWork = workMembership.isInWork(record);
    session.doneSuggested = workMembership.isDoneSuggested(record);
  }
  return Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined && value !== null));
};

export const isListedAsChild = (record: ListedSessionRecord) => sessionParentId(record) !== null;
