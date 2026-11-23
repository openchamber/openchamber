// Owns the per-space browser-preview bookkeeping of the Electron main
// process: which local tunnel ports each isolated space currently exposes,
// and the promise chain that serializes that space's proxy updates.
//
// A space's entry used to live for the whole process lifetime: closing the
// last port emptied the port set but kept the entry — and the hardened
// preview session it referenced — forever, so creating, previewing and
// removing spaces accumulated stale state in the long-lived desktop
// process. teardown() is the explicit release path for a removed space: it
// queues behind any in-flight proxy update, then drops the entry and hands
// the space back through releaseSpace so the caller can drop its per-space
// session tracking too. A space that appears again afterwards simply
// starts from a fresh entry and re-applies its proxy normally.
export const createSpacePreviewState = ({ applyProxy, releaseSpace, onProxyError } = {}) => {
  const entries = new Map();

  const entryOf = (spaceId) => {
    let entry = entries.get(spaceId);
    if (!entry || entry.retired) {
      entry = { ports: new Set(), chain: Promise.resolve(), retired: false };
      entries.set(spaceId, entry);
    }
    return entry;
  };

  const queueApplyOn = (entry, spaceId) => {
    entry.chain = entry.chain.catch(() => {}).then(() => applyProxy(spaceId, [...entry.ports]));
    return entry.chain;
  };

  const prepare = (spaceId) => queueApplyOn(entryOf(spaceId), spaceId);

  const openPort = (spaceId, localPort) => {
    const entry = entryOf(spaceId);
    entry.ports.add(localPort);
    return queueApplyOn(entry, spaceId);
  };

  const closePort = (spaceId, localPort) => {
    const entry = entries.get(spaceId);
    if (!entry || !entry.ports.delete(localPort) || entry.retired) return Promise.resolve();
    return queueApplyOn(entry, spaceId);
  };

  const closeAll = () => {
    for (const [spaceId, entry] of entries) {
      if (entry.retired || entry.ports.size === 0) continue;
      entry.ports.clear();
      queueApplyOn(entry, spaceId).catch((error) => {
        try {
          onProxyError?.(spaceId, error);
        } catch {
          // Reporting must never turn a handled failure back into an
          // unhandled rejection.
        }
      });
    }
  };

  const teardown = (spaceId) => {
    const entry = entries.get(spaceId);
    if (!entry || entry.retired) return Promise.resolve(false);
    entry.retired = true;
    entry.chain = entry.chain.catch(() => {}).then(() => {
      // A fresh entry may have replaced this one while the teardown was
      // queued (the space came back); that entry owns the space now, so
      // leave both it and the shared per-space session alone.
      if (entries.get(spaceId) !== entry) return false;
      entries.delete(spaceId);
      releaseSpace?.(spaceId);
      return true;
    });
    return entry.chain;
  };

  return {
    prepare,
    openPort,
    closePort,
    closeAll,
    teardown,
    has: (spaceId) => {
      const entry = entries.get(spaceId);
      return Boolean(entry && !entry.retired);
    },
    portsOf: (spaceId) => {
      const entry = entries.get(spaceId);
      return entry && !entry.retired ? [...entry.ports] : [];
    },
    get size() {
      return entries.size;
    },
  };
};
