import React from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { formatTimeForPreference } from '@/lib/timeFormat';
import type { Theme } from '@/types/theme';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { buildMobileWidgetSnapshot } from './mobileWidgetSnapshot';
import { createWidgetUsageSnapshot } from './widgetUsageSnapshot';

type InstalledWidgets = { usage: boolean; sessions: boolean };
type WidgetSnapshots = { usage?: string; sessions?: string };

type WidgetBridge = {
  update(args: WidgetSnapshots): Promise<void>;
  installed(): Promise<InstalledWidgets>;
  pendingRefresh(): Promise<{ requested: number; acknowledged: number }>;
  acknowledgeRefresh(args: { requested: number }): Promise<void>;
  reportRefreshFailure(args: { requested: number }): Promise<void>;
  addListener(eventName: 'refreshRequested' | 'widgetsChanged', listener: () => void): Promise<PluginListenerHandle>;
};

const WidgetBridge = registerPlugin<WidgetBridge>('WidgetBridge');

const QUOTA_STALE_MS = 5 * 60_000;
const WRITE_DEBOUNCE_MS = 1_000;

const themePalette = (theme?: Theme) => {
  const colors = theme?.colors;
  return {
    variant: theme?.metadata.variant === 'light' ? 'light' : 'dark',
    background: colors?.surface.elevated ?? colors?.surface.background,
    primary: colors?.primary.base,
    foreground: colors?.surface.foreground,
    muted: colors?.surface.mutedForeground,
    info: colors?.status.info,
    success: colors?.status.success,
    warning: colors?.status.warning,
    error: colors?.status.error,
  };
};

type WidgetLabels = Record<string, string>;

export const useNativeWidgetSync = ({ enabled }: { enabled: boolean }): void => {
  const { t } = useI18n();
  const activeTheme = useOptionalThemeSystem()?.currentTheme;
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const palette = React.useMemo(() => themePalette(activeTheme), [activeTheme]);
  const labels = React.useMemo<WidgetLabels>(() => ({
    sessionsTitle: t('mobile.androidWidget.sessions.title'),
    sessionsEmpty: t('mobile.androidWidget.sessions.empty'),
    newSession: t('mobile.androidWidget.sessions.new'),
    untitled: t('mobile.sessions.untitled'),
    running: t('mobile.androidWidget.status.running'),
    retrying: t('mobile.androidWidget.status.retrying'),
    error: t('mobile.androidWidget.status.error'),
    usageTitle: t('mobile.androidWidget.usage.title'),
    usageEmpty: t('mobile.androidWidget.usage.empty'),
    remaining: t('mobile.androidWidget.usage.remaining'),
    used: t('mobile.androidWidget.usage.used'),
    updated: t('mobile.androidWidget.updated', { time: '%s' }),
    refreshing: t('mobile.androidWidget.refreshing'),
    queued: t('mobile.androidWidget.queued'),
    failed: t('mobile.androidWidget.failed'),
    refresh: t('mobile.androidWidget.refresh'),
  }), [t]);

  React.useEffect(() => {
    if (!enabled || Capacitor.getPlatform() !== 'android') return;
    let disposed = false;
    let installed: InstalledWidgets = { usage: false, sessions: false };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;

    const write = async () => {
      const sessionsKnown = installed.sessions && useGlobalSessionsStore.getState().hasLoaded;
      const quotas = useQuotaStore.getState();
      const usageKnown = installed.usage && quotas.loadedRuntimeKey !== null;
      if (!sessionsKnown && !usageKnown) return;
      const time = (at: number) => formatTimeForPreference(at, timeFormatPreference);
      const snapshots: WidgetSnapshots = {};
      if (usageKnown) {
        const updated = quotas.lastUpdated === null ? '' : time(quotas.lastUpdated);
        const usage = createWidgetUsageSnapshot(quotas, { t, timeFormatPreference });
        snapshots.usage = JSON.stringify({ updated, labels, palette, ...usage });
      }
      if (sessionsKnown) {
        snapshots.sessions = JSON.stringify({ updated: time(Date.now()), labels, palette, ...buildMobileWidgetSnapshot() });
      }
      await WidgetBridge.update(snapshots);
    };

    const schedule = () => {
      if (disposed || timer !== null || (!installed.usage && !installed.sessions)) return;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) void write().catch(() => undefined);
      }, WRITE_DEBOUNCE_MS);
    };

    const loadQuotas = (refresh: boolean) => {
      if (!installed.usage) return Promise.resolve();
      return useQuotaStore.getState().ensureLoadedForRuntime({ refresh });
    };

    const refreshPlaced = async (): Promise<boolean> => {
      const quotasBefore = useQuotaStore.getState().lastUpdated;
      const [, sessions] = await Promise.allSettled([
        loadQuotas(true),
        installed.sessions ? useGlobalSessionsStore.getState().refreshSessionHead() : Promise.resolve(true),
      ]);
      const quotasAfter = useQuotaStore.getState().lastUpdated;
      const sessionsOk = sessions.status === 'fulfilled' && sessions.value;
      const quotasOk = !installed.usage || (quotasAfter !== null && quotasAfter !== quotasBefore);
      await write();
      return sessionsOk && quotasOk;
    };

    const handleRefreshRequest = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        for (;;) {
          const pending = await WidgetBridge.pendingRefresh();
          if (disposed || pending.requested <= pending.acknowledged) return;
          const ok = await refreshPlaced().catch(() => false);
          if (disposed) return;
          if (!ok) {
            await WidgetBridge.reportRefreshFailure({ requested: pending.requested });
            return;
          }
          await WidgetBridge.acknowledgeRefresh({ requested: pending.requested });
        }
      } catch {
        // The bridge itself failed; the request stays queued for the next foreground.
      } finally {
        refreshing = false;
      }
    };

    const syncInstalled = async () => {
      const next = await WidgetBridge.installed().catch(() => installed);
      if (disposed) return;
      const usageAdded = next.usage && !installed.usage;
      installed = next;
      if (usageAdded) void loadQuotas(false).finally(schedule);
      const sessions = useGlobalSessionsStore.getState();
      if (installed.sessions && !sessions.hasLoaded) void sessions.loadSessions().catch(() => undefined).finally(schedule);
      schedule();
    };

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void syncInstalled().then(() => {
        const lastUpdated = useQuotaStore.getState().lastUpdated;
        if (installed.usage && (lastUpdated === null || Date.now() - lastUpdated > QUOTA_STALE_MS)) {
          void loadQuotas(true).catch(() => undefined).finally(schedule);
        }
        void handleRefreshRequest();
      });
    };

    const unsubscribers = [
      useQuotaStore.subscribe(schedule),
      useGlobalSessionsStore.subscribe(schedule),
      useGlobalSessionStatusStore.subscribe(schedule),
      useSessionUIStore.subscribe((state, previous) => {
        if (state.availableWorktreesByProject !== previous.availableWorktreesByProject) schedule();
      }),
      useProjectsStore.subscribe(schedule),
    ];
    const handles: Array<Promise<PluginListenerHandle | null>> = [
      WidgetBridge.addListener('refreshRequested', () => { void handleRefreshRequest(); }).catch(() => null),
      WidgetBridge.addListener('widgetsChanged', () => { void syncInstalled(); }).catch(() => null),
    ];
    document.addEventListener('visibilitychange', onVisible);
    void syncInstalled().then(() => handleRefreshRequest());

    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const handle of handles) void handle.then((h) => h?.remove());
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, labels, palette, t, timeFormatPreference]);
};
