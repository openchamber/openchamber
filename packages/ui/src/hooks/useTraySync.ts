import React from 'react';
import { useIdleDesktopUpdate } from '@/hooks/useIdleDesktopUpdate';
import type { Session } from '@/lib/opencode/model';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopLocalOriginActive } from '@/lib/desktop';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { desktopHostsGet, getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useBackgroundImagesStore } from '@/sync/background-images';
import { collectOpenTurnSessionIds, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { usePrWatchStore } from '@/sync/pr-watch';
import { useExtensionWaitsStore } from '@/sync/extension-waits';
import { useWorkflowActivityStore } from '@/sync/workflow-activity';
import {
  useGlobalBlockingRequestsStore,
  type BlockingFormRequest,
  type BlockingPermissionRequest,
} from '@/sync/global-blocking-requests';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { isSessionUnread, isSessionUnreadWithError } from '@/sync/session-unread';
import { markAllSessionsViewed } from '@/sync/notification-store';
import { respondToPermission } from '@/sync/session-actions';
import { canSavePermission } from '@/components/chat/permissionSummary';
import {
  useGlobalSessionsStore,
  ensureGlobalSessionsLoaded,
  resolveGlobalSessionDirectory,
} from '@/stores/useGlobalSessionsStore';
import { createSessionLineage } from '@/stores/sessionLineage';
import { refreshTrayQuotas, useQuotaStore } from '@/stores/useQuotaStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { formatWindowLabel, formatQuotaWindowValueLabel, quotaProviderList } from '@/lib/quota';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { resolveProjectForSessionDirectory, normalizeProjectPath } from '@/lib/projectResolution';
import { isSessionDirectoryAdmitted } from '@/sync/session-admission-rule';
import { CHAT_DRAFT_PROJECT_ID, isChatDirectoryPath } from '@/lib/chatDirectories';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { getSessionPinList, isSessionPinned } from '@/lib/sessionPins';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { sessionHasSidebarRow } from '@/lib/sidebarSessionRows';
import { resolveSessionNestingParentId } from '@/lib/sessionWorkLineage';
import { findWorktreeHoldingDirectory } from '@/lib/worktrees/worktreePaths';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { toast } from '@/components/ui';
import { afterDelay } from '@/lib/timing/afterDelay';
import { isChatListedInPinSections, resolveVisibleSidebarSections } from '@/components/session/sidebar/sections/sectionMembership';
import { buildSidebarWorkFacts, type SidebarLiveFacts } from '@/components/session/sidebar/sections/workFacts';

const TRAY_ACTION_EVENT = 'openchamber:tray-action';
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
  subtitle: string;
};

type TrayApproval = {
  kind: 'permission' | 'form';
  id: string;
  sessionId: string;
  sessionTitle: string;
  label: string;
  directory: string;
  canSave: boolean;
};

type TrayUsageRow = { label: string; value: string };
type TrayUsageGroup = { provider: string; account: string | null; rows: TrayUsageRow[]; status: string | null };
type TrayUsage = { mode: 'usage' | 'remaining'; groups: TrayUsageGroup[] };

type TraySnapshot = {
  sessions: TraySession[];
  approvals: TrayApproval[];
  instanceName: string;
  usage: TrayUsage;
  dockBadgeCount: number;
  dockUnreadSessions: { id: string; title: string; directory: string }[];
};

type TrayAction =
  | { type: 'mark-all-read' }
  | { type: 'menu-opened' }
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
  const head = request.action.trim();
  const resource = request.resources.find((item) => item.trim());
  return head && resource ? `${head}: ${resource}` : head || resource || '';
};

const formLabel = (request: BlockingFormRequest): string => request.title.trim();

const NO_PINNED_SESSIONS = new Set<string>();

const compareSessionOrder = (left: Session, right: Session): number => (
  compareSessionsByLifecycleOrder(
    left,
    right,
    NO_PINNED_SESSIONS,
    useSessionOrderingStore.getState().rankById,
  )
);

const basenameOf = (p: string): string => {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
};

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

  let branch = (normDir && branchByDirectory.get(normDir)) || '';
  if (!branch) {
    for (const [dir, gitState] of useGitStore.getState().directories) {
      if (normalizeProjectPath(dir) === normDir) { branch = gitState.status?.current ?? ''; break; }
    }
  }
  if (!branch) {
    for (const worktrees of worktreesByProject.values()) {
      const match = normDir ? findWorktreeHoldingDirectory(worktrees, normDir) : undefined;
      if (match?.branch) { branch = match.branch; break; }
    }
  }

  return branch ? `${projectName} · ${branch}` : projectName;
};

const buildUsage = (): TrayUsage => {
  const { dictionary } = useI18nStore.getState();
  const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) => formatMessage(dictionary, key, params);
  const { results, dropdownProviderIds, displayMode, extensionProviders } = useQuotaStore.getState();
  const mode: TrayUsage['mode'] = displayMode === 'remaining' ? 'remaining' : 'usage';
  if (!dropdownProviderIds.length) return { mode, groups: [] };

  const byProvider = new Map(results.map((result) => [result.providerId, result]));
  const groups: TrayUsageGroup[] = [];
  for (const meta of quotaProviderList(extensionProviders)) {
    if (!dropdownProviderIds.includes(meta.id)) continue;
    const result = byProvider.get(meta.id);
    if (!result || result.configured !== true) continue;

    const rows: TrayUsageRow[] = [];
    for (const [label, window] of Object.entries(result.usage?.windows ?? {})) {
      const percent = mode === 'remaining' ? window.remainingPercent : window.usedPercent;
      rows.push({ label: formatWindowLabel(label), value: formatQuotaWindowValueLabel(window, percent, t, mode) });
    }

    const status = !result.ok && result.error
      ? result.error
      : rows.length === 0
        ? t('header.services.noRateLimitsReported')
        : null;
    const account = meta.id === 'opencode-go' ? result.accountLabel?.trim() || null : null;
    groups.push({ provider: meta.name, account, rows, status });
  }
  return { mode, groups };
};

const resolveInstanceName = async (): Promise<{ kind: 'local' | 'fallback' } | { kind: 'named'; name: string } | null> => {
  try {
    if (isDesktopLocalOriginActive()) return { kind: 'local' };
    const localOrigin = (window as unknown as { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__
      || window.location.origin;
    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) return { kind: 'local' };
    const cfg = await desktopHostsGet();
    const match = cfg.hosts.find((host) =>
      runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host)) : false);
    if (match?.label?.trim()) return { kind: 'named', name: redactSensitiveUrl(match.label.trim()) };
    return { kind: 'fallback' };
  } catch {
    return null;
  }
};

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
    if (state.vcs?.branch) branchByDirectory.set(normalizeProjectPath(directory) ?? directory, state.vcs.branch);

    for (const session of state.session) {
      if (!session?.id) continue;
      titleById.set(session.id, session.title);
    }

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
        approvals.push({ kind: 'permission', id: request.id, sessionId: sid, sessionTitle: '', label: permissionLabel(request), directory, canSave: canSavePermission(request.save) });
      }
    }
    for (const [sessionId, requests] of Object.entries(state.form ?? {})) {
      for (const request of requests ?? []) {
        if (!request?.id) continue;
        const sid = request.sessionID || sessionId;
        approvals.push({ kind: 'form', id: request.id, sessionId: sid, sessionTitle: '', label: formLabel(request), directory, canSave: false });
      }
    }
  }

  return { statusById, branchByDirectory, approvals, titleById };
};

const buildSnapshot = (instanceName: string, includeTray: boolean): TraySnapshot => {
  const allSessions = useGlobalSessionsStore.getState().activeSessions;
  const lineage = createSessionLineage(allSessions);
  const collectDescendants = (rootId: string): string[] => (
    lineage.descendantsOf(rootId, 'active').map((session) => session.id)
  );

  const projects = useProjectsStore.getState().projects;
  const worktreesByProject = useSessionUIStore.getState().availableWorktreesByProject;

  const pinnedIds = useSessionPinnedStore.getState().ids;
  const display = useSessionDisplayStore.getState();
  const shownSections: Sections = {
    chats: display.showChatsSection,
    pinned: display.showPinnedSection,
    work: useUIStore.getState().sessionWorkEnabled && display.showWorkSection,
  };
  const visibleSections = resolveVisibleSidebarSections({
    sections: display.sections,
    hiddenSections: display.hiddenSections,
    draft: null,
    draftIsNew: false,
    show: shownSections,
    keepWorkInPlace: display.keepWorkInPlace,
    keepPinnedInPlace: display.keepPinnedInPlace,
    customSections: true,
    pages: false,
  });

  const openTurnIds = collectOpenTurnSessionIds(useGlobalSessionStatusStore.getState().activeSessionIds, [
    useWorkflowActivityStore.getState().runningSessionIds,
    useBackgroundShellsStore.getState().sessionIds,
    useBackgroundImagesStore.getState().sessionIds,
    usePrWatchStore.getState().bySession.keys(),
    useExtensionWaitsStore.getState().bySession.keys(),
  ]);
  const hasUnreadTurn = (session: Session): boolean => isSessionUnread(session) && !openTurnIds.has(session.id);

  let factsContext: Parameters<typeof buildSidebarWorkFacts>[1] | null = null;
  const chatFactsContext = (): Parameters<typeof buildSidebarWorkFacts>[1] => {
    if (factsContext) return factsContext;
    const familySessions = [...allSessions, ...useGlobalSessionsStore.getState().archivedSessions];
    const sessionById = new Map(familySessions.map((session) => [session.id, session]));
    const childrenMap = new Map<string, Session[]>();
    for (const session of familySessions) {
      const parentId = resolveSessionNestingParentId(session, (id) => sessionById.get(id));
      if (!parentId) continue;
      const siblings = childrenMap.get(parentId);
      if (siblings) siblings.push(session);
      else childrenMap.set(parentId, [session]);
    }
    const live: SidebarLiveFacts = {
      activeIds: openTurnIds,
      blockingIds: new Set([...useGlobalBlockingRequestsStore.getState().bySession].flatMap(([sessionId, pending]) => (
        pending.permissions.length + pending.forms.length + pending.pages.length > 0 ? [sessionId] : []
      ))),
      unreadIds: new Set(allSessions.filter((session) => !session.parentID && hasUnreadTurn(session)).map((session) => session.id)),
      failedIds: new Set(allSessions.filter((session) => !session.parentID && session.outcome === 'failed').map((session) => session.id)),
    };
    factsContext = {
      sessionById,
      childrenMap,
      runKeyBySessionId: new Map(),
      live,
      planSessionIds: new Set(),
      folderByMember: new Map(),
    };
    return factsContext;
  };

  type Sections = { chats: boolean; pinned: boolean; work: boolean };
  const hasRowIn = (session: Session, sections: Sections): boolean => {
    const directory = resolveGlobalSessionDirectory(session);
    const isAdmitted = isSessionDirectoryAdmitted(directory, projects, worktreesByProject);
    if (isChatDirectoryPath(directory) || session.projectID === CHAT_DRAFT_PROJECT_ID) {
      const isPinned = isSessionPinned(pinnedIds, session.directory, session.id);
      const inPinSection = (): boolean => isPinned && isChatListedInPinSections(
        visibleSections,
        getSessionPinList(session),
        () => buildSidebarWorkFacts({ kind: 'session', key: `session:${session.id}`, projectId: null, rootSessionId: session.id, chat: true }, chatFactsContext()),
        Date.now(),
      );
      return sessionHasSidebarRow(session, { isAdmitted, isPlaced: sections.chats || inPinSection(), isPinned: false, zones: { pinned: false, work: false } });
    }
    return sessionHasSidebarRow(session, {
      isAdmitted,
      isPlaced: isSpaceDirectory(directory)
        || resolveProjectForSessionDirectory(projects, worktreesByProject, directory) !== null,
      isPinned: isSessionPinned(pinnedIds, session.directory, session.id),
      zones: sections,
    });
  };
  const allSections: Sections = { chats: true, pinned: true, work: true };

  const dockUnread = useUIStore.getState().dockBadgeEnabled
    ? allSessions.filter((session) => hasUnreadTurn(session) && hasRowIn(session, shownSections))
    : [];
  const dockBadgeCount = dockUnread.length;
  const dockUnreadSessions = dockUnread
    .sort((left, right) => (right.time.idle ?? right.time.updated) - (left.time.idle ?? left.time.updated) || left.id.localeCompare(right.id))
    .slice(0, 10)
    .map((session) => ({ id: session.id, title: session.title, directory: resolveGlobalSessionDirectory(session) ?? '' }));
  if (!includeTray) {
    return { sessions: [], approvals: [], instanceName, usage: { mode: 'usage', groups: [] }, dockBadgeCount, dockUnreadSessions };
  }

  const live = collectLiveData();
  const titleById = new Map<string, string>(live.titleById);
  for (const session of allSessions) {
    if (session?.id && session.title) titleById.set(session.id, session.title);
  }

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
    if (family.some((id) => openTurnIds.has(id))) return 'busy';
    return 'idle';
  };

  const sessions: TraySession[] = allSessions
    .filter((s) => s?.id && !s.parentID)
    .filter((session) => hasRowIn(session, allSections))
    .slice()
    .sort(compareSessionOrder)
    .slice(0, MAX_SESSIONS)
    .map((session) => {
      const family = [session.id, ...collectDescendants(session.id)];
      const directory = resolveGlobalSessionDirectory(session) ?? '';
      return {
        id: session.id,
        title: session.title || '',
        status: rollupStatus(family),
        branch: directory ? (live.branchByDirectory.get(directory) ?? '') : '',
        unseen: hasUnreadTurn(session) ? 1 : 0,
        hasError: hasUnreadTurn(session) && isSessionUnreadWithError(session),
        directory,
        subtitle: resolveSessionSubtitle(directory, session, projects, worktreesByProject, live.branchByDirectory),
      };
    });

  const approvals = live.approvals.map((a) => ({ ...a, sessionTitle: titleById.get(a.sessionId) || '' }));
  const seen = new Set(approvals.map((a) => a.id));
  for (const [sessionId, pending] of useGlobalBlockingRequestsStore.getState().bySession) {
    const sessionTitle = titleById.get(sessionId) || '';
    for (const request of pending.permissions) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      approvals.push({ kind: 'permission', id: request.id, sessionId, sessionTitle, label: permissionLabel(request), directory: pending.directory, canSave: canSavePermission(request.save) });
    }
    for (const request of [...pending.forms, ...pending.pages]) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      approvals.push({ kind: 'form', id: request.id, sessionId, sessionTitle, label: formLabel(request), directory: pending.directory, canSave: false });
    }
  }

  return {
    sessions,
    approvals: approvals.filter((approval) => isSessionDirectoryAdmitted(approval.directory, projects, worktreesByProject)),
    instanceName, usage: buildUsage(), dockBadgeCount, dockUnreadSessions,
  };
};

export const useTraySync = (): void => {
  useIdleDesktopUpdate();
  React.useEffect(() => {
    if (!isTrayPlatform() || !canUseElectronDesktopIPC()) return;
    const trayEnabled = isTrayEnabled();

    let disposed = false;
    let lastSerialized = '';
    let flushTimer: number | null = null;
    let instance: Awaited<ReturnType<typeof resolveInstanceName>> = null;
    let cancelActivityClock: (() => void) | null = null;
    const armActivityClock = () => {
      if (trayEnabled || cancelActivityClock !== null) return;
      const { sections, hiddenSections } = useSessionDisplayStore.getState();
      if (!sections.some((entry) => entry.kind === 'custom' && !hiddenSections.includes(entry.id) && entry.grouping === 'time'
        && entry.filter.pins.length > 0 && entry.filter.activity !== 'any')) return;
      const nextHour = new Date();
      nextHour.setMinutes(60, 0, 0);
      cancelActivityClock = afterDelay(nextHour.getTime() - Date.now(), () => {
        cancelActivityClock = null;
        flushNow();
      });
    };
    const flushNow = () => {
      if (disposed) return;
      armActivityClock();
      const { dictionary } = useI18nStore.getState();
      const instanceName = instance?.kind === 'named' ? instance.name
        : instance?.kind === 'local' ? formatMessage(dictionary, 'tray.instance.local')
          : instance?.kind === 'fallback' ? formatMessage(dictionary, 'tray.instance.fallback') : '';
      const snapshot = buildSnapshot(instanceName, trayEnabled);
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      void invokeDesktop('desktop_tray_update', snapshot);
    };

    const scheduleFlush = () => {
      if (disposed || flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        flushNow();
      }, FLUSH_DEBOUNCE_MS);
    };

    const unsubscribeGlobal = useGlobalSessionsStore.subscribe(() => scheduleFlush());
    const unsubscribeLocale = useI18nStore.subscribe((state, previous) => {
      if (state.dictionary !== previous.dictionary) scheduleFlush();
    });
    const unsubscribeGlobalStatus = useGlobalSessionStatusStore.subscribe(() => scheduleFlush());
    const unsubscribeWorkflows = useWorkflowActivityStore.subscribe(() => scheduleFlush());
    const unsubscribeShells = useBackgroundShellsStore.subscribe(() => scheduleFlush());
    const unsubscribeImages = useBackgroundImagesStore.subscribe(() => scheduleFlush());
    const unsubscribePrWatches = usePrWatchStore.subscribe(() => scheduleFlush());
    const unsubscribeExtensionWaits = useExtensionWaitsStore.subscribe(() => scheduleFlush());
    const unsubscribeUI = useUIStore.subscribe((state, previous) => {
      if (state.dockBadgeEnabled !== previous.dockBadgeEnabled
        || state.sessionWorkEnabled !== previous.sessionWorkEnabled) {
        scheduleFlush();
      }
    });
    const unsubscribeProjects = useProjectsStore.subscribe(() => scheduleFlush());
    const unsubscribeWorktrees = useSessionUIStore.subscribe(() => scheduleFlush());
    const unsubscribePins = useSessionPinnedStore.subscribe(() => scheduleFlush());
    const unsubscribeSections = useSessionDisplayStore.subscribe((state, previous) => {
      if (state.showChatsSection !== previous.showChatsSection
        || state.showPinnedSection !== previous.showPinnedSection
        || state.showWorkSection !== previous.showWorkSection
        || state.sections !== previous.sections
        || state.hiddenSections !== previous.hiddenSections) {
        scheduleFlush();
      }
    });
    const unsubscribeGlobalRequests = useGlobalBlockingRequestsStore.subscribe(() => scheduleFlush());
    const stopBadgeSync = () => {
      disposed = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      cancelActivityClock?.();
      unsubscribeGlobalRequests();
      unsubscribeGlobal();
      unsubscribeLocale();
      unsubscribeGlobalStatus();
      unsubscribeWorkflows();
      unsubscribeShells();
      unsubscribeImages();
      unsubscribePrWatches();
      unsubscribeExtensionWaits();
      unsubscribeUI();
      unsubscribeProjects();
      unsubscribeWorktrees();
      unsubscribePins();
      unsubscribeSections();
    };

    if (!trayEnabled) {
      flushNow();
      return stopBadgeSync;
    }

    void resolveInstanceName().then((name) => {
      if (disposed) return;
      instance = name;
      flushNow();
    });

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

    const unsubscribeGit = useGitStore.subscribe(() => scheduleFlush());
    const unsubscribeSessionOrder = useSessionOrderingStore.subscribe(() => scheduleFlush());

    const unsubscribeQuota = useQuotaStore.subscribe(() => scheduleFlush());
    const unsubscribeQuotaReady = useConfigStore.subscribe((state, previous) => {
      if (state.isInitialized && !previous.isInitialized) refreshTrayQuotas(true);
    });
    refreshTrayQuotas(true);

    const interval = window.setInterval(() => { rebindStores(); flushNow(); }, POLL_INTERVAL_MS);

    flushNow();

    return () => {
      stopBadgeSync();
      window.clearInterval(interval);
      unsubscribeGit();
      unsubscribeSessionOrder();
      unsubscribeQuota();
      unsubscribeQuotaReady();
      unsubscribeRegistry?.();
      for (const unsub of storeUnsubs.values()) unsub();
      storeUnsubs.clear();
    };
  }, []);

  React.useEffect(() => {
    if (!isTrayPlatform() || !canUseElectronDesktopIPC()) return;
    const bridge = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
    const listen = bridge?.listen;
    if (typeof listen !== 'function') return;

    const handle = (action: TrayAction) => {
      switch (action.type) {
        case 'mark-all-read':
          void ensureGlobalSessionsLoaded().then(() => markAllSessionsViewed()).catch(() => {});
          break;
        case 'menu-opened':
          if (isTrayEnabled()) refreshTrayQuotas();
          break;
        case 'respond-permission':
          void respondToPermission(action.sessionId, action.id, action.response).catch(() => {
            toast.error('Failed to respond to permission request');
          });
          break;
      }
    };

    let unlisten: null | (() => void | Promise<void>) = null;
    let disposed = false;
    listen(TRAY_ACTION_EVENT, (evt) => {
      const action = evt?.payload as TrayAction | undefined;
      if (!action || typeof action !== 'object' || typeof action.type !== 'string') return;
      handle(action);
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
        void invokeDesktop('desktop_tray_actions_ready');
      })
      .catch(() => {   });

    return () => {
      disposed = true;
      try {
        const result = unlisten?.();
        if (result instanceof Promise) void result.catch(() => {});
      } catch {
        // ignore
      }
    };
  }, []);
};
