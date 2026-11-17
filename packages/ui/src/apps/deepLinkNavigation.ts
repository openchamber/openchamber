import React from 'react';
import { Capacitor } from '@capacitor/core';

import { isCapacitorApp } from '@/lib/platform';
import { subscribeToNativeShortcutRequests } from '@/lib/nativeShortcutRequests';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId } from '@/types';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { openSession } from '@/lib/router/openSessionFromRoute';

import { parseDeepLink, type DeepLinkIntent, type SessionsFilter, type ViewTarget } from './deepLinks';


interface DeepLinkHandlers {
  openSessions?: (filter?: SessionsFilter) => void;
  openView?: (target: ViewTarget) => void;
  openChanges?: (options?: { path?: string; staged?: boolean }) => void;
  openSettings?: (section?: string) => void;
}

type ShortcutNewSessionIntent = { type: 'shortcut-new-session'; projectId?: string; text?: string };

type NavigationIntent = DeepLinkIntent | ShortcutNewSessionIntent;

let handlers: DeepLinkHandlers = {};
let ready = false;
let pending: NavigationIntent | null = null;
let launchUrlConsumed = false;

const openShortcutSession = (intent: ShortcutNewSessionIntent): void => {
  const store = useSessionUIStore.getState();
  const project = intent.projectId
    ? useProjectsStore.getState().projects.find((entry) => entry.id === intent.projectId) ?? null
    : null;
  store.openNewSessionDraft(project ? { selectedProjectId: project.id } : undefined);
  const text = intent.text?.trim();
  if (!text) return;
  if (intent.projectId && !project) {
    useInputStore.getState().setPendingInputText(text, 'append');
    return;
  }
  useInputStore.getState().requestDraftSubmit(useSessionUIStore.getState().newSessionDraft.draftId, text);
};

const execute = (intent: NavigationIntent): boolean => {
  switch (intent.type) {
    case 'shortcut-new-session':
      openShortcutSession(intent);
      return true;

    case 'session':
      void openSession(intent.sessionId, { directory: intent.directory ?? null, messageId: intent.messageId ?? null });
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

const flush = (): void => {
  if (!ready || !pending) return;
  const intent = pending;
  pending = null;
  if (!execute(intent)) {
    pending = intent;
  }
};

const applyDeepLinkIntent = (intent: NavigationIntent): void => {
  pending = intent;
  flush();
};

const applyDeepLinkUrl = (raw: string | null | undefined): void => {
  const intent = parseDeepLink(raw);
  if (intent) {
    applyDeepLinkIntent(intent);
  }
};

const setReady = (value: boolean): void => {
  ready = value;
  flush();
};

export const useDeepLinkHandlers = (next: DeepLinkHandlers): void => {
  React.useEffect(() => {
    handlers = next;
    flush();
    return () => {
      if (handlers === next) {
        handlers = {};
      }
    };
  }, [next]);
};

export const useDeepLinkSource = (options: { ready: boolean }): void => {
  const { ready: isReady } = options;

  React.useEffect(() => {
    setReady(isReady);
  }, [isReady]);

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
      applyDeepLinkIntent({ type: 'shortcut-new-session', projectId: request.projectId, text: request.text });
    }));

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;
        const handle = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const data = action?.notification?.data as Record<string, unknown> | undefined;
          const url = typeof data?.url === 'string' ? data.url : typeof data?.deeplink === 'string' ? data.deeplink : undefined;
          if (url) {
            applyDeepLinkUrl(url);
            return;
          }
          const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : undefined;
          if (sessionId) {
            applyDeepLinkIntent({ type: 'session', sessionId });
          }
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
