import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopLocalOriginActive } from '@/lib/desktop';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { desktopHostsGet, getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import {
  useGlobalBlockingRequestsStore,
  type BlockingFormRequest,
  type BlockingPermissionRequest,
} from '@/sync/global-blocking-requests';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { useNotificationStore } from '@/sync/notification-store';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { respondToPermission } from '@/sync/session-actions';
import {
  useGlobalSessionsStore,
  resolveGlobalSessionDirectory,
} from '@/stores/useGlobalSessionsStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { QUOTA_PROVIDERS, formatWindowLabel, formatQuotaValueLabel } from '@/lib/quota';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { resolveProjectForSessionDirectory, normalizeProjectPath } from '@/lib/projectResolution';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { toast } from '@/components/ui';

// Native tray/menu bar bridge. The Electron main process owns the Tray UI; this hook
// streams a compact snapshot of live session/approval state to it via the
// `desktop_tray_update` IPC command, and routes tray clicks back into the app.
//
// Dock badges share the IPC command, but remain active when the menu bar is
// disabled. That path observes unread state only, without tray polling or quotas.

const TRAY_ACTION_EVENT = 'openchamber:tray-action';
// Event-driven updates do the real work; this is just a slow safety net.
const POLL_INTERVAL_MS = 5000;
const FLUSH_DEBOUNCE_MS = 500;
const MAX_SESSIONS = 20;

type TraySessionStatus = 'idle' | 'busy' | 'retry';

type TraySession = {
  id: string;
  title: string;
  status: TraySessionStatus;
  branch: string;
  unseen: number;
  hasError: boolean;
  directory: string;
  // Secondary line for the menu row: "project · branch" (rendered as sublabel).
  subtitle: string;
};

type TrayApproval = {
  kind: 'permission' | 'form';
  id: string;
  sessionId: string;
  sessionTitle: string;
  label: string;
  directory: string;
};

type TrayUsageRow = { label: string; value: string };
type TrayUsageGroup = { provider: string; rows: TrayUsageRow[]; status: string | null };
type TrayUsage = { mode: 'usage' | 'remaining'; groups: TrayUsageGroup[] };

type TraySnapshot = {
  sessions: TraySession[];
  approvals: TrayApproval[];
  // Active instance label (e.g. "Local OpenChamber" or a remote host name) so
  // the tray header makes clear which instance/window it reflects.
  instanceName: string;
  // Provider rate-limit usage, only for providers the user enabled for the
  // dropdown (same "configured to show" rule as the header/mobile). Empty
  // groups → the tray omits the Usage submenu entirely.
  usage: TrayUsage;
  // Number of chats (root sessions) with unseen activity, for the macOS dock
  // badge. 0 when the user disabled the badge — the main process clears it.
  dockBadgeCount: number;
};

// focus-session / new-session are routed natively by the main process through
// the existing `openchamber:open-session` / `openchamber:open-draft-session`
// events (handled in App.tsx). Only respond-permission needs handling here.
type TrayAction =
  | { type: 'respond-permission'; sessionId: string; id: string; response: 'once' | 'always' | 'reject' };

type DesktopBridgeGlobal = {
  listen?: (
    event: string,
    handler: (evt: { payload?: unknown }) => void
  ) => Promise<() => void>;
};

const isTrayPlatform = (): boolean => {
  if (typeof window === 'undefined') return false;
  const platform = (window as unknown as { __OPENCHAMBER_PLATFORM__?: string }).__OPENCHAMBER_PLATFORM__;
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
};

const isTrayEnabled = (): boolean =>
  typeof window !== 'undefined' && window.__OPENCHAMBER_ELECTRON__?.trayEnabled !== false;

const permissionLabel = (request: BlockingPermissionRequest): string => {
  const head = request.action.trim() || 'Permission';
  const resource = request.resources.find((item) => item.trim());
  return resource ? `${head}: ${resource}` : head;
};

const formLabel = (request: BlockingFormRequest): string => request.title.trim() || 'Question';

const compareSessionOrder = (left: Session, right: Session): number => (
  compareSessionsByLifecycleOrder(
    left,
    right,
    useSessionPinnedStore.getState().ids,
    useSessionOrderingStore.getState().rankById,
  )
);

const basenameOf = (p: string): string => {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
};

// Resolve the "project · branch" metadata line for a session from its directory,
// covering both project-root sessions and worktree sessions (which map back to
// their parent project). Branch prefers the live VCS value; falls back to the
// worktree's recorded branch when the directory isn't currently synced.
const resolveSessionSubtitle = (
  directory: string,
  session: Session,
  projects: ProjectEntry[],
  worktreesByProject: Map<string, WorktreeMetadata[]>,
  branchByDirectory: Map<string, string>,
): string => {
  if (!directory) return '';
  const project = resolveProjectForSessionDirectory(projects, worktreesByProject, directory);
  const globalProjectName = (session as { project?: { name?: string } | null }).project?.name;
  const projectName = project?.label?.trim() || globalProjectName?.trim() || basenameOf(directory);
  const normDir = normalizeProjectPath(directory);

  // Branch resolution, most-authoritative first: live VCS from the sync store,
  // then the git store's cached status (covers project-root sessions whose
  // directory isn't actively synced), then recorded worktree metadata.
  let branch = (normDir && branchByDirectory.get(normDir)) || '';
  if (!branch) {
    for (const [dir, gitState] of useGitStore.getState().directories) {
      if (normalizeProjectPath(dir) === normDir) { branch = gitState.status?.current ?? ''; break; }
    }
  }
  if (!branch) {
    for (const worktrees of worktreesByProject.values()) {
      const match = worktrees.find((wt) => normalizeProjectPath(wt.path) === normDir);
      if (match?.branch) { branch = match.branch; break; }
    }
  }

  return branch ? `${projectName} · ${branch}` : projectName;
};

// Build the usage groups exactly like the header/mobile: only providers the
// user enabled for the dropdown AND that report as configured. Window rows only
// (the headline limits) — model breakdowns stay in the full UI.
const buildUsage = (): TrayUsage => {
  const { results, dropdownProviderIds, displayMode } = useQuotaStore.getState();
  const mode: TrayUsage['mode'] = displayMode === 'remaining' ? 'remaining' : 'usage';
  if (!dropdownProviderIds.length) return { mode, groups: [] };

  const byProvider = new Map(results.map((result) => [result.providerId, result]));
  const groups: TrayUsageGroup[] = [];
  for (const meta of QUOTA_PROVIDERS) {
    if (!dropdownProviderIds.includes(meta.id)) continue;
    const result = byProvider.get(meta.id);
    if (!result || result.configured !== true) continue;

    const rows: TrayUsageRow[] = [];
    for (const [label, window] of Object.entries(result.usage?.windows ?? {})) {
      const percent = mode === 'remaining' ? window.remainingPercent : window.usedPercent;
      rows.push({ label: formatWindowLabel(label), value: formatQuotaValueLabel(window.valueLabel, percent) });
    }

    const status = !result.ok && result.error
      ? result.error
      : rows.length === 0
        ? 'No rate limits reported'
        : null;
    groups.push({ provider: meta.name, rows, status });
  }
  return { mode, groups };
};

// Mirrors the header's instance resolution (Header.refreshCurrentInstanceLabel):
// the local origin shows as "Local OpenChamber"; a remote host shows its
// configured name. Async because the host config is read over IPC.
const resolveInstanceName = async (): Promise<string> => {
  try {
    if (isDesktopLocalOriginActive()) return 'Local OpenChamber';
    const localOrigin = (window as unknown as { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__
      || window.location.origin;
    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) return 'Local OpenChamber';
    const cfg = await desktopHostsGet();
    const match = cfg.hosts.find((host) =>
      runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host)) : false);
    if (match?.label?.trim()) return redactSensitiveUrl(match.label.trim());
    return 'Instance';
  } catch {
    return '';
  }
};

// Live data lives in the directory-scoped sync child stores. Aggregate it once
// into flat lookups so we can attach it to the global session list by id.
type LiveData = {
  statusById: Map<string, TraySessionStatus>;
  branchByDirectory: Map<string, string>;
  approvals: TrayApproval[];
  titleById: Map<string, string>;
};

const collectLiveData = (): LiveData => {
  const statusById = new Map<string, TraySessionStatus>();
  const branchByDirectory = new Map<string, string>();
  const approvals: TrayApproval[] = [];
  const titleById = new Map<string, string>();

  let stores;
  try {
    stores = getSyncChildStores();
  } catch {
    return { statusById, branchByDirectory, approvals, titleById };
  }

  for (const [directory, store] of stores.children.entries()) {
    const state = store.getState();
    // Normalize the key so it matches the session directory regardless of
    // trailing slashes / separators.
    if (state.vcs?.branch) branchByDirectory.set(normalizeProjectPath(directory) ?? directory, state.vcs.branch);

    for (const session of state.session) {
      if (!session?.id) continue;
      titleById.set(session.id, session.title);
    }

    // Status comes from the status map itself, NOT from the session list — a
    // just-created session can have a live status entry before (or without)
    // appearing in this store's list, and the same session can be listed by
    // several stores. Never let one store's missing/idle entry clobber another
    // store's busy/retry.
    for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
      const type = status?.type;
      const mapped: TraySessionStatus = type === 'busy' ? 'busy' : type === 'retry' ? 'retry' : 'idle';
      const existing = statusById.get(sessionId);
      if (!existing || existing === 'idle') statusById.set(sessionId, mapped);
    }

    for (const [sessionId, requests] of Object.entries(state.permission ?? {})) {
      for (const request of requests ?? []) {
        if (!request?.id) continue;
        const sid = request.sessionID || sessionId;
        approvals.push({ kind: 'permission', id: request.id, sessionId: sid, sessionTitle: '', label: permissionLabel(request), directory });
      }
    }
    for (const [sessionId, requests] of Object.entries(state.form ?? {})) {
      for (const request of requests ?? []) {
        if (!request?.id) continue;
        const sid = request.sessionID || sessionId;
        approvals.push({ kind: 'form', id: request.id, sessionId: sid, sessionTitle: '', label: formLabel(request), directory });
      }
    }
  }

  return { statusById, branchByDirectory, approvals, titleById };
};

// Status for sessions outside the synced child stores arrives two ways, both
// landing in useGlobalSessionStatusStore (the fallback in the rollup below):
//  - live: the global event stream carries status events for every directory;
//    the sync dispatcher routes the ones without a child store into the store;
//  - seeded: events only deliver changes, so the root global-sessions poll
//    seeds the store from the host's cross-project map (`/api/sessions/status`,
//    see `sync/host-session-status-seed.ts`). The tray no longer polls the
//    upstream `/session/status?directory=` endpoint: that call creates an
//    OpenCode instance per directory.
const buildSnapshot = (instanceName: string, includeTray: boolean): TraySnapshot => {
  const notif = useNotificationStore.getState().index.session;

  // The list source is the GLOBAL store — every project/worktree the backend
  // knows about, independent of which directories this client has opened. Live
  // status/unread/branch are merged in by id where we have them (the session's
  // directory is synced); otherwise the row is shown as idle.
  const allSessions = useGlobalSessionsStore.getState().activeSessions;
  const childrenByParent = new Map<string, string[]>();
  for (const session of allSessions) {
    if (!session?.id) continue;
    if (session.parentID) {
      const siblings = childrenByParent.get(session.parentID) ?? [];
      siblings.push(session.id);
      childrenByParent.set(session.parentID, siblings);
    }
  }

  const collectDescendants = (rootId: string): string[] => {
    const out: string[] = [];
    const stack = [...(childrenByParent.get(rootId) ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      stack.push(...(childrenByParent.get(id) ?? []));
    }
    return out;
  };

  // Count the full root list, independently of the tray's visibility and limit.
  const ui = useUIStore.getState();
  let dockBadgeCount = 0;
  if (ui.dockBadgeEnabled) {
    for (const session of allSessions) {
      if (!session?.id || session.parentID) continue;
      let familyUnseen = notif.unseenCount[session.id] ?? 0;
      if (familyUnseen === 0 && ui.notifyOnSubtasks) {
        familyUnseen = collectDescendants(session.id)
          .reduce((sum, id) => sum + (notif.unseenCount[id] ?? 0), 0);
      }
      if (familyUnseen > 0) dockBadgeCount += 1;
    }
  }
  if (!includeTray) {
    return { sessions: [], approvals: [], instanceName, usage: { mode: 'usage', groups: [] }, dockBadgeCount };
  }

  const live = collectLiveData();
  const titleById = new Map<string, string>(live.titleById);
  for (const session of allSessions) {
    if (session?.id && session.title) titleById.set(session.id, session.title);
  }

  // A session is active if EITHER source says so: the synced child stores
  // (instant, but can miss sessions created outside this window) or the
  // cross-project status map (event-driven for every directory + polled
  // reconciliation). Requiring agreement would re-introduce the gaps.
  const globalStatusById = useGlobalSessionStatusStore.getState().statusById;
  const resolveStatus = (id: string): TraySessionStatus => {
    const fromStores = live.statusById.get(id);
    if (fromStores && fromStores !== 'idle') return fromStores;
    return globalStatusById.get(id)?.status.type ?? fromStores ?? 'idle';
  };

  const rollupStatus = (family: string[]): TraySessionStatus => {
    const statuses = family.map((id) => resolveStatus(id));
    if (statuses.includes('busy')) return 'busy';
    if (statuses.includes('retry')) return 'retry';
    return 'idle';
  };

  const projects = useProjectsStore.getState().projects;
  const worktreesByProject = useSessionUIStore.getState().availableWorktreesByProject;

  const sessions: TraySession[] = allSessions
    .filter((s) => s?.id && !s.parentID) // root rows; sub-session work rolls up
    .slice()
    .sort(compareSessionOrder)
    .slice(0, MAX_SESSIONS)
    .map((session) => {
      const family = [session.id, ...collectDescendants(session.id)];
      const directory = resolveGlobalSessionDirectory(session) ?? '';
      return {
        id: session.id,
        title: session.title || 'Untitled session',
        status: rollupStatus(family),
        branch: directory ? (live.branchByDirectory.get(directory) ?? '') : '',
        unseen: family.reduce((sum, id) => sum + (notif.unseenCount[id] ?? 0), 0),
        hasError: family.some((id) => notif.unseenHasError[id] ?? false),
        directory,
        subtitle: resolveSessionSubtitle(directory, session, projects, worktreesByProject, live.branchByDirectory),
      };
    });

  // Directory stores list approvals for open directories; the cross-directory
  // index adds the ones from directories this window never initialized.
  const approvals = live.approvals.map((a) => ({ ...a, sessionTitle: titleById.get(a.sessionId) || '' }));
  const seen = new Set(approvals.map((a) => a.id));
  for (const [sessionId, pending] of useGlobalBlockingRequestsStore.getState().bySession) {
    const sessionTitle = titleById.get(sessionId) || '';
    for (const request of pending.permissions) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      approvals.push({ kind: 'permission', id: request.id, sessionId, sessionTitle, label: permissionLabel(request), directory: pending.directory });
    }
    for (const request of pending.forms) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      approvals.push({ kind: 'form', id: request.id, sessionId, sessionTitle, label: formLabel(request), directory: pending.directory });
    }
  }

  return { sessions, approvals, instanceName, usage: buildUsage(), dockBadgeCount };
};

export const useTraySync = (): void => {
  React.useEffect(() => {
    if (!isTrayPlatform() || !canUseElectronDesktopIPC()) return;
    const trayEnabled = isTrayEnabled();

    let disposed = false;
    let lastSerialized = '';
    let flushTimer: number | null = null;
    // The active instance is fixed per window load (switching hosts re-navigates
    // the window, remounting this hook). Resolve it once, then re-push.
    let instanceName = '';
    const flushNow = () => {
      if (disposed) return;
      const snapshot = buildSnapshot(instanceName, trayEnabled);
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      void invokeDesktop('desktop_tray_update', snapshot);
    };

    // Coalesce bursts (e.g. token-by-token streaming updates a store rapidly)
    // into at most one push per FLUSH_DEBOUNCE_MS; discrete events surface within
    // that window. The main app UI stays instant via SSE/stores.
    const scheduleFlush = () => {
      if (disposed || flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        flushNow();
      }, FLUSH_DEBOUNCE_MS);
    };

    const unsubscribeNotif = useNotificationStore.subscribe(() => scheduleFlush());
    const unsubscribeGlobal = useGlobalSessionsStore.subscribe(() => scheduleFlush());
    const unsubscribeUI = useUIStore.subscribe((state, previous) => {
      if (state.dockBadgeEnabled !== previous.dockBadgeEnabled || state.notifyOnSubtasks !== previous.notifyOnSubtasks) {
        scheduleFlush();
      }
    });
    const stopBadgeSync = () => {
      disposed = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      unsubscribeNotif();
      unsubscribeGlobal();
      unsubscribeUI();
    };

    if (!trayEnabled) {
      flushNow();
      return stopBadgeSync;
    }

    void resolveInstanceName().then((name) => {
      if (disposed) return;
      instanceName = name;
      flushNow();
    });

    // Event-driven: subscribe to each directory store so session create/update/
    // status changes propagate immediately, and to the registry so stores for
    // newly-opened directories get wired up as they appear.
    const storeUnsubs = new Map<string, () => void>();

    const rebindStores = () => {
      if (disposed) return;
      let stores;
      try {
        stores = getSyncChildStores();
      } catch {
        return;
      }
      const live = new Set<string>();
      for (const [directory, store] of stores.children.entries()) {
        live.add(directory);
        if (!storeUnsubs.has(directory)) {
          storeUnsubs.set(directory, store.subscribe(() => scheduleFlush()));
        }
      }
      for (const [directory, unsub] of storeUnsubs) {
        if (!live.has(directory)) {
          unsub();
          storeUnsubs.delete(directory);
        }
      }
    };

    let unsubscribeRegistry: (() => void) | null = null;
    try {
      unsubscribeRegistry = getSyncChildStores().subscribeRegistry(() => {
        rebindStores();
        scheduleFlush();
      });
    } catch {
      // Sync provider not mounted yet — the fallback poll below recovers.
    }
    rebindStores();

    // Project labels and discovered worktrees feed the "project · branch"
    // subtitle; refresh the tray when they change (deduped, so cheap).
    const unsubscribeProjects = useProjectsStore.subscribe(() => scheduleFlush());
    const unsubscribeWorktrees = useSessionUIStore.subscribe(() => scheduleFlush());
    const unsubscribeGit = useGitStore.subscribe(() => scheduleFlush());
    // Cross-project status map: fed live by the sync dispatcher from the global
    // event stream and seeded from the host by the root global-sessions poll.
    // The tray used to poll `/session/status?directory=` for up to 20
    // directories every 5 seconds, which made OpenCode create an instance for
    // each of them; the host seed covers the same startup gap for free.
    const unsubscribeGlobalStatus = useGlobalSessionStatusStore.subscribe(() => scheduleFlush());
    const unsubscribeGlobalRequests = useGlobalBlockingRequestsStore.subscribe(() => scheduleFlush());
    const unsubscribeSessionOrder = useSessionOrderingStore.subscribe(() => scheduleFlush());
    const unsubscribePinnedSessions = useSessionPinnedStore.subscribe(() => scheduleFlush());

    // Usage: push to the tray whenever the quota store changes, and do one
    // initial fetch for enabled providers so the submenu isn't empty on launch.
    const unsubscribeQuota = useQuotaStore.subscribe(() => scheduleFlush());
    void useQuotaStore.getState().loadSettings().then(() => {
      if (disposed) return;
      const { dropdownProviderIds, results } = useQuotaStore.getState();
      const needsFetch = dropdownProviderIds.length > 0
        && dropdownProviderIds.some((id) => !results.some((r) => r.providerId === id));
      if (needsFetch) void useQuotaStore.getState().fetchQuotas(dropdownProviderIds);
    });

    // Safety net: catches anything the event subscriptions miss (e.g. a store
    // that existed before the registry subscription was attached).
    const interval = window.setInterval(() => { rebindStores(); flushNow(); }, POLL_INTERVAL_MS);

    flushNow();

    return () => {
      stopBadgeSync();
      window.clearInterval(interval);
      unsubscribeProjects();
      unsubscribeWorktrees();
      unsubscribeGit();
      unsubscribeGlobalStatus();
      unsubscribeGlobalRequests();
      unsubscribeSessionOrder();
      unsubscribePinnedSessions();
      unsubscribeQuota();
      unsubscribeRegistry?.();
      for (const unsub of storeUnsubs.values()) unsub();
      storeUnsubs.clear();
    };
  }, []);

  React.useEffect(() => {
    if (!isTrayPlatform() || !isTrayEnabled() || !canUseElectronDesktopIPC()) return;
    const bridge = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
    const listen = bridge?.listen;
    if (typeof listen !== 'function') return;

    const handle = (action: TrayAction) => {
      switch (action.type) {
        case 'respond-permission':
          void respondToPermission(action.sessionId, action.id, action.response).catch(() => {
            toast.error('Failed to respond to permission request');
          });
          break;
      }
    };

    let unlisten: null | (() => void | Promise<void>) = null;
    listen(TRAY_ACTION_EVENT, (evt) => {
      const action = evt?.payload as TrayAction | undefined;
      if (!action || typeof action !== 'object' || typeof action.type !== 'string') return;
      handle(action);
    })
      .then((fn) => { unlisten = fn; })
      .catch(() => { /* ignore */ });

    return () => {
      try {
        const result = unlisten?.();
        if (result instanceof Promise) void result.catch(() => {});
      } catch {
        // ignore
      }
    };
  }, []);
};
