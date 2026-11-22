import { parseBoundedIntWithDefault } from '../shared/parse-int.js';

export const DEFAULT_OPENCODE_DRAIN_GRACE_MS = 30 * 60 * 1000;
const DRAIN_POLL_MS = 1000;

export const resolveOpenCodeDrainGraceMs = (env) => {
  // The strict plain-decimal judgement lives in shared/parse-int.js (design
  // #802 phase 2, #804), matching the sibling strict readers: a bare
  // Number(...) would silently honour '1e3' (a 1 s grace), '0x10' (16 ms),
  // '5.9', '+5000', and '5000.0', and a whitespace-only value would become a
  // zero grace instead of the default. An explicit '0' is a real zero grace.
  return parseBoundedIntWithDefault(env.OPENCHAMBER_OPENCODE_DRAIN_GRACE_MS, DEFAULT_OPENCODE_DRAIN_GRACE_MS, 0, Number.MAX_SAFE_INTEGER);
};

// An OpenCode that has been replaced stays up until nothing depends on it: no proxied
// request still answers from its port, and every session that was busy when it was
// replaced has gone idle. A session with an unknown busy set (recovered after an
// OpenChamber restart) is only released by the grace period.
export const createDrainingOpenCodeRegistry = ({
  graceMs,
  countRequests,
  listBusySessionIds,
  onChange = () => {},
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) => {
  const entries = new Map();
  let timer = null;

  const snapshot = () => [...entries.values()].map(({ pid, port, binary, drainStartedAt }) => ({
    pid,
    port,
    binary,
    drainStartedAt,
  }));

  const stopTimer = () => {
    if (timer === null) return;
    clearIntervalImpl(timer);
    timer = null;
  };

  const release = async (entry, reason) => {
    if (entries.get(entry.pid) !== entry) return;
    entries.delete(entry.pid);
    if (entries.size === 0) stopTimer();
    onChange(snapshot());
    try {
      await entry.close();
    } catch (error) {
      console.warn(`[OpenCode] closing drained OpenCode ${entry.pid} failed:`, error?.message ?? error);
    }
    console.log(`[OpenCode] drained OpenCode ${entry.pid} (${reason})`);
  };

  const check = () => {
    const current = now();
    const busyNow = new Set(listBusySessionIds());
    for (const entry of [...entries.values()]) {
      if (entry.busySessionIds) {
        entry.busySessionIds = entry.busySessionIds.filter((id) => busyNow.has(id));
      }
      const quiet = entry.busySessionIds !== null && entry.busySessionIds.length === 0 && countRequests(entry.port) === 0;
      if (quiet) {
        void release(entry, 'idle');
      } else if (current - entry.drainStartedAt >= graceMs) {
        void release(entry, 'grace-expired');
      }
    }
  };

  return {
    add({ pid, port, binary, drainStartedAt = now(), busySessionIds = null, close }) {
      if (entries.has(pid)) return;
      entries.set(pid, { pid, port, binary, drainStartedAt, busySessionIds, close });
      onChange(snapshot());
      if (timer === null) {
        timer = setIntervalImpl(check, DRAIN_POLL_MS);
        timer.unref?.();
      }
    },
    has(pid) {
      return entries.has(pid);
    },
    snapshot,
    async closeAll(reason) {
      stopTimer();
      await Promise.all([...entries.values()].map((entry) => release(entry, reason)));
    },
  };
};
