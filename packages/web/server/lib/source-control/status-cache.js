export const createChangeRequestStatusCache = ({ ttlMs, maxEntries = 500, now = Date.now }) => {
  const entries = new Map();
  let epoch = 0;

  const keyOf = (context) => JSON.stringify([
    context.instance, context.accountId, context.credentialRevision,
    context.repositoryId, context.bindingRevision, context.directory, context.branch, context.remote, context.localTip ?? null,
  ]);

  return Object.freeze({
    fresh: (context) => {
      const entry = entries.get(keyOf(context));
      return entry && now() - entry.fetchedAt < ttlMs ? entry.data : null;
    },
    last: (context) => entries.get(keyOf(context))?.data ?? null,
    begin: () => epoch,
    store: (context, data, started = epoch) => {
      const fetchedAt = Number.isFinite(data.fetchedAt) ? data.fetchedAt : now();
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
    invalidate: (scope) => {
      epoch += 1;
      for (const [key, entry] of entries) {
        if (Object.entries(scope).every(([field, value]) => entry[field] === value)) entries.delete(key);
      }
    },
  });
};
