import { isSourceControlFiniteNumber } from './input-guards.js';
import type { SourceControlJsonObject } from '@openchamber/sdk';

export interface StatusCacheContext {
  instance: string;
  accountId: string;
  credentialRevision: number | null;
  repositoryId: string;
  bindingRevision: number;
  directory: string;
  branch: string;
  remote: string;
  localTip?: string | null;
}
export interface StatusCacheOptions {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}
type StatusCacheScope = Partial<Pick<StatusCacheContext, 'instance' | 'accountId' | 'repositoryId' | 'directory' | 'branch'>>;
type StampedStatus<Status> = Status & { fetchedAt: number };
interface StatusCacheEntry<Status> {
  [field: string]: string | number | StampedStatus<Status>;
  data: StampedStatus<Status>;
  fetchedAt: number;
  instance: string;
  accountId: string;
  repositoryId: string;
  directory: string;
  branch: string;
}

export const createChangeRequestStatusCache = <Status extends { fetchedAt?: unknown } = SourceControlJsonObject>({ ttlMs, maxEntries = 500, now = Date.now }: StatusCacheOptions) => {
  const entries = new Map<string, StatusCacheEntry<Status>>();
  let epoch = 0;

  const keyOf = (context: StatusCacheContext) => JSON.stringify([
    context.instance, context.accountId, context.credentialRevision,
    context.repositoryId, context.bindingRevision, context.directory, context.branch, context.remote, context.localTip ?? null,
  ]);

  return Object.freeze({
    fresh: (context: StatusCacheContext) => {
      const entry = entries.get(keyOf(context));
      return entry && now() - entry.fetchedAt < ttlMs ? entry.data : null;
    },
    last: (context: StatusCacheContext) => entries.get(keyOf(context))?.data ?? null,
    begin: () => epoch,
    store: (context: StatusCacheContext, data: Status, started = epoch) => {
      const fetchedAt = isSourceControlFiniteNumber(data.fetchedAt) ? data.fetchedAt : now();
      const stamped = { ...data, fetchedAt };
      if (started !== epoch) return stamped;
      const key = keyOf(context);
      if (entries.size >= maxEntries && !entries.has(key)) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, {
        data: stamped, fetchedAt, instance: context.instance, accountId: context.accountId, repositoryId: context.repositoryId,
        directory: context.directory, branch: context.branch,
      });
      return stamped;
    },
    invalidate: (scope: StatusCacheScope) => {
      epoch += 1;
      for (const [key, entry] of entries) {
        if (Object.entries(scope).every(([field, value]) => entry[field] === value)) entries.delete(key);
      }
    },
  });
};
