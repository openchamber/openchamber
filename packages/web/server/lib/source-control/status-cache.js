/**
 * Last-known change request status, per bound read context.
 *
 * Status is polled from every sidebar row and Git panel that shows a branch,
 * so a provider outage or rate limit would otherwise turn every badge into an
 * error at once. The cache answers a fresh repeat within `ttlMs` without a
 * provider round trip, and after a transient failure it answers with what it
 * last saw, so a badge keeps its last-known state until the provider is back.
 *
 * An entry is keyed by the exact trusted context that produced it, credential
 * revision included, so a removed or rotated credential never receives a
 * response it did not earn. A mutation drops every entry of its repository
 * because the next read must see the provider's answer, not this one.
 */
export const createChangeRequestStatusCache = ({ ttlMs, maxEntries = 500, now = Date.now }) => {
  const entries = new Map();

  const keyOf = (context) => JSON.stringify([
    context.instance, context.accountId, context.credentialRevision,
    context.repositoryId, context.bindingRevision, context.directory, context.branch, context.remote,
  ]);

  return Object.freeze({
    /** The stored status when it is younger than `ttlMs`, else null. */
    fresh: (context) => {
      const entry = entries.get(keyOf(context));
      return entry && now() - entry.fetchedAt < ttlMs ? entry.data : null;
    },
    /** The stored status regardless of age, else null. */
    last: (context) => entries.get(keyOf(context))?.data ?? null,
    store: (context, data) => {
      const key = keyOf(context);
      if (entries.size >= maxEntries && !entries.has(key)) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      const fetchedAt = Number.isFinite(data.fetchedAt) ? data.fetchedAt : now();
      entries.set(key, { data: { ...data, fetchedAt }, fetchedAt, instance: context.instance, accountId: context.accountId, repositoryId: context.repositoryId });
    },
    /** Drops every entry whose stored scope matches all given fields. */
    invalidate: (scope) => {
      for (const [key, entry] of entries) {
        if (Object.entries(scope).every(([field, value]) => entry[field] === value)) entries.delete(key);
      }
    },
  });
};
