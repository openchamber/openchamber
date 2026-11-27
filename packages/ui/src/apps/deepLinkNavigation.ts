import React from 'react';
import { z } from 'zod';
import { Capacitor } from '@capacitor/core';

import { isCapacitorApp } from '@/lib/platform';
import { subscribeToNativeShortcutRequests } from '@/lib/nativeShortcutRequests';
import {
  reportSkippedSharedFiles,
  subscribeToNativeSharedFiles,
  type RejectedSharedFile,
} from '@/lib/nativeSharedFiles';
import { keepWorkDraftOwnSlot } from '@/lib/chatDraftPersistence';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { createSessionDraftId } from '@/stores/useSessionDraftsStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId } from '@/types';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openSession } from '@/lib/router/openSessionFromRoute';
import { requestTrackerItemOpen } from '@/lib/trackerItemRequests';

import { parseDeepLink, type DeepLinkIntent, type SessionsFilter, type ViewTarget } from './deepLinks';
import type { SavedInstanceSwitchOutcome } from './mobileConnections';


interface DeepLinkHandlers {
  showChat?: () => void;
  openSessions?: (filter?: SessionsFilter) => void;
  openView?: (target: ViewTarget) => void;
  openChanges?: (options?: { path?: string; staged?: boolean }) => void;
  openSettings?: (section?: string) => void;
}

type ShortcutNewSessionIntent = { type: 'shortcut-new-session'; projectId?: string; text?: string; dictate?: boolean };

type SharedFilesIntent = {
  type: 'shared-files';
  files: File[];
  text: string | null;
  rejected: RejectedSharedFile[];
  accept?: () => void;
};

type NavigationIntent = DeepLinkIntent | ShortcutNewSessionIntent;

type InstanceSwitcher = (serverId: string) => Promise<SavedInstanceSwitchOutcome>;

let handlers: DeepLinkHandlers = {};
let launchUrlConsumed = false;

export const openShortcutSession = (intent: ShortcutNewSessionIntent): void => {
  const store = useSessionUIStore.getState();
  const project = intent.projectId
    ? useProjectsStore.getState().projects.find((entry) => entry.id === intent.projectId) ?? null
    : null;
  store.openNewSessionDraft(project ? { selectedProjectId: project.id } : undefined);
  if (intent.dictate) {
    useInputStore.getState().requestDraftDictation(useSessionUIStore.getState().newSessionDraft.draftId);
  }
  const text = intent.text?.trim();
  if (!text) return;
  if (intent.projectId && !project) {
    useInputStore.getState().setPendingInputText(text, 'append');
    return;
  }
  useInputStore.getState().requestDraftSubmit(useSessionUIStore.getState().newSessionDraft.draftId, text);
};

export const openSharedFilesSession = (intent: SharedFilesIntent): boolean => {
  if (intent.files.length === 0 && !intent.text) {
    reportSkippedSharedFiles(intent.rejected);
    intent.accept?.();
    return true;
  }
  const projects = useProjectsStore.getState();
  const project = projects.getActiveProject() ?? projects.projects[0] ?? null;
  if (!project && !projects.hasServerSnapshot && !projects.serverSnapshotFailed) return false;
  const workDraftId = createSessionDraftId();
  keepWorkDraftOwnSlot(workDraftId);
  useSessionUIStore.getState().openNewSessionDraft(project
    ? { workDraftId, selectedProjectId: project.id }
    : { workDraftId, target: 'chat' });
  const draftId = useSessionUIStore.getState().newSessionDraft.draftId;
  useInputStore.getState().requestDraftContent(draftId, intent);
  return true;
};

const execute = (intent: NavigationIntent): boolean => {
  switch (intent.type) {
    case 'shortcut-new-session':
      if (!handlers.showChat) return false;
      handlers.showChat();
      openShortcutSession(intent);
      return true;

    case 'session':
      void openSession(intent.sessionId, { directory: intent.directory ?? null, messageId: intent.messageId ?? null });
      return true;

    case 'tracker-item':
      requestTrackerItemOpen({ url: intent.url, directory: intent.directory ?? null });
      return true;

    case 'new-session': {
      const store = useSessionUIStore.getState();
      store.openNewSessionDraft();
      if (intent.directory || intent.projectId) {
        store.setNewSessionDraftTarget({
          directoryOverride: intent.directory ?? null,
          projectId: intent.projectId ?? null,
          selectedProjectId: intent.projectId ?? null,
        });
      }
      return true;
    }

    case 'sessions':
      if (!handlers.openSessions) return false;
      handlers.openSessions(intent.filter);
      return true;

    case 'status':
      if (!handlers.openSessions) return false;
      handlers.openSessions();
      return true;


    case 'view':
      if (!handlers.openView) return false;
      handlers.openView(intent.target);
      return true;

    case 'changes':
      if (!handlers.openChanges) return false;
      handlers.openChanges({ path: intent.path, staged: intent.staged });
      return true;

    case 'settings':
      if (!handlers.openSettings) return false;
      if (intent.section === 'usage' && intent.providerId) {
        // SAFETY: parseDeepLink admits only well-formed provider ids, and the widgets send ids
        // taken from the quota store's own results.
        useQuotaStore.getState().setSelectedProvider(intent.providerId as QuotaProviderId);
      }
      handlers.openSettings(intent.section);
      return true;
  }
};

export const createDeepLinkQueue = <Intent extends { type: string; serverId?: string }>(run: (intent: Intent) => boolean) => {
  let ready = false;
  let pending: Intent | null = null;
  let switchToServer: InstanceSwitcher | null = null;
  let switching: Promise<void> | null = null;
  let waitingForSwitchedRuntime = false;

  const switchThenFlush = (switcher: InstanceSwitcher, serverId: string): Promise<void> => switcher(serverId).then((outcome) => {
    switching = null;
    if (!pending || pending.serverId !== serverId) return flush();
    if (outcome === 'unavailable') {
      pending = null;
      return undefined;
    }
    if (outcome === 'switched') {
      waitingForSwitchedRuntime = true;
      ready = false;
      return undefined;
    }
    pending.serverId = undefined;
    return flush();
  }, () => {
    switching = null;
    pending = null;
  });

  const flush = (): Promise<void> => {
    if (switching) return switching;
    if (!pending || waitingForSwitchedRuntime) return Promise.resolve();
    const intent = pending;
    if (intent.serverId && switchToServer) {
      switching = switchThenFlush(switchToServer, intent.serverId);
      return switching;
    }
    if (!ready) return Promise.resolve();
    pending = null;
    if (!run(intent)) pending = intent;
    return Promise.resolve();
  };

  return {
    apply: (intent: Intent): Promise<void> => {
      pending = intent;
      return flush();
    },
    setReady: (value: boolean, switcher: InstanceSwitcher | null): Promise<void> => {
      ready = value;
      switchToServer = switcher;
      if (value) waitingForSwitchedRuntime = false;
      return flush();
    },
    flush,
  };
};

const queue = createDeepLinkQueue<NavigationIntent>(execute);
const shareQueue = createDeepLinkQueue<SharedFilesIntent>(openSharedFilesSession);
useProjectsStore.subscribe((state, previous) => {
  if (
    state.projects === previous.projects
    && state.hasServerSnapshot === previous.hasServerSnapshot
    && state.serverSnapshotFailed === previous.serverSnapshotFailed
  ) return;
  queueMicrotask(() => void shareQueue.flush());
});

const applyDeepLinkIntent = (intent: NavigationIntent): void => {
  void queue.apply(intent);
};

const applyDeepLinkUrl = (raw: string | null | undefined): void => {
  const intent = parseDeepLink(raw);
  if (intent) {
    applyDeepLinkIntent(intent);
  }
};

const notificationTapDataSchema = z.object({
  serverId: z.string().min(1).optional().catch(undefined),
  sessionId: z.string().min(1).optional().catch(undefined),
  url: z.string().optional().catch(undefined),
});

export type NotificationTapData = z.input<typeof notificationTapDataSchema>;

export const notificationTapIntent = (data: NotificationTapData | null | undefined): DeepLinkIntent | null => {
  const parsed = notificationTapDataSchema.safeParse(data ?? {});
  if (!parsed.success) return null;
  const { serverId, sessionId, url } = parsed.data;
  const fromUrl = parseDeepLink(url);
  const intent: DeepLinkIntent | null = fromUrl ?? (sessionId ? { type: 'session', sessionId } : null);
  if ((intent?.type === 'session' || intent?.type === 'tracker-item') && serverId) intent.serverId = serverId;
  return intent;
};

export const useDeepLinkHandlers = (next: DeepLinkHandlers): void => {
  React.useEffect(() => {
    handlers = next;
    void queue.flush();
    void shareQueue.flush();
    return () => {
      if (handlers === next) {
        handlers = {};
      }
    };
  }, [next]);
};

export const useDeepLinkSource = (options: {
  ready: boolean;
  switchToServer?: (serverId: string) => Promise<SavedInstanceSwitchOutcome>;
}): void => {
  const { ready: isReady, switchToServer } = options;

  React.useEffect(() => {
    void queue.setReady(isReady, switchToServer ?? null);
    void shareQueue.setReady(isReady, null);
  }, [isReady, switchToServer]);

  React.useEffect(() => {
    if (!isCapacitorApp()) return;
    let disposed = false;
    const cleanup: Array<() => void> = [];

    void import('@capacitor/app')
      .then(async ({ App }) => {
        if (disposed) return;
        const handle = await App.addListener('appUrlOpen', (event) => {
          applyDeepLinkUrl(event?.url);
        });
        if (disposed) {
          void handle.remove();
          return;
        }
        cleanup.push(() => void handle.remove());
        // external: https://capacitorjs.com/docs/apis/app#getlaunchurl Android cold-launch URLs require getLaunchUrl and are consumed once per process.
        if (!launchUrlConsumed && Capacitor.getPlatform() === 'android') {
          launchUrlConsumed = true;
          const initial = await App.getLaunchUrl().catch(() => null);
          if (!disposed && initial?.url) applyDeepLinkUrl(initial.url);
        }
      })
      .catch(() => undefined);

    cleanup.push(subscribeToNativeShortcutRequests((request) => {
      applyDeepLinkIntent({ type: 'shortcut-new-session', projectId: request.projectId, text: request.text, dictate: request.dictate });
    }));

    cleanup.push(subscribeToNativeSharedFiles((payload, accept) => {
      void shareQueue.apply({ type: 'shared-files', files: payload.files, text: payload.text, rejected: payload.rejected, accept });
    }));

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;
        const handle = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const intent = notificationTapIntent(action?.notification?.data);
          if (intent) applyDeepLinkIntent(intent);
        });
        if (disposed) {
          void handle.remove();
          return;
        }
        cleanup.push(() => void handle.remove());
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };
  }, []);
};
