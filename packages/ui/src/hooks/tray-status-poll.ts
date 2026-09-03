import type { Session } from '@opencode-ai/sdk/v2';
import { resolveGlobalSessionDirectory } from '@/stores/globalSessionStructure';
import { getSyncChildStores } from '@/sync/sync-refs';

// How many root sessions the tray menu shows. The status poll targets exactly
// the directories those visible rows live in, so both sides share the cap.
export const TRAY_MAX_SESSIONS = 20;

type TrayStatusPollInput = {
  /** Cross-project active session list — the tray's row source. */
  sessions: readonly Session[];
  /** Directories that already have an initialized sync child store. */
  syncedDirectories: ReadonlySet<string>;
  compareSessions: (left: Session, right: Session) => number;
};

/**
 * Directories the tray polls `/session/status` for, each mapped to the session
 * ids the global list places there so the snapshot can authoritatively clear
 * stale entries by id.
 *
 * Only directories WITHOUT an initialized child store are polled. A directory
 * with a child store is already covered by sync-context: bootstrap seeds its
 * status, the live event stream updates both the child store and the global
 * status index, and the active-session watchdog polls and escalates its active
 * candidates on the same 5s cadence. Polling it here as well duplicated that
 * request per directory every tick, which showed up on the server as sustained
 * file and Git reads.
 *
 * Both sides of the comparison are `normalizePath` output: child-store keys and
 * `resolveGlobalSessionDirectory` normalize with the same function.
 */
export const collectTrayStatusPollTargets = (
  { sessions, syncedDirectories, compareSessions }: TrayStatusPollInput,
): Map<string, string[]> => {
  const pollableRootDirectories = new Set<string>();
  sessions
    .filter((session) => session?.id && !session.parentID)
    .sort(compareSessions)
    .slice(0, TRAY_MAX_SESSIONS)
    .forEach((session) => {
      const directory = resolveGlobalSessionDirectory(session);
      if (!directory || syncedDirectories.has(directory)) return;
      pollableRootDirectories.add(directory);
    });

  const targets = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session?.id) continue;
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory || !pollableRootDirectories.has(directory)) continue;
    const ids = targets.get(directory) ?? [];
    ids.push(session.id);
    targets.set(directory, ids);
  }
  return targets;
};

/**
 * Directories with an initialized child store.
 *
 * An empty set when the sync provider has not mounted yet, which keeps the
 * tray's fallback intact: with no synced directory known, every visible
 * directory is polled exactly as before.
 */
export const readSyncedDirectories = (): ReadonlySet<string> => {
  try {
    return new Set(getSyncChildStores().children.keys());
  } catch {
    return new Set();
  }
};
