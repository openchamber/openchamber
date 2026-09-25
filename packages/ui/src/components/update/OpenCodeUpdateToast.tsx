import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { updateDesktopSettings } from '@/lib/persistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import {
  resolveOpenCodeUpdateVersion,
  shouldShowOpenCodeUpdateToast,
} from './openCodeUpdateDedup';
import { fetchOpenCodeUpgradeStatus, runOpenCodeUpgrade } from './openCodeUpgrade';

const UPDATE_TOAST_ID = 'opencode-update-available';
const UPGRADE_TOAST_ID = 'opencode-upgrade-progress';
const INITIAL_CHECK_DELAY_MS = 5_000;
const CHECK_RETRY_DELAYS_MS = [10_000, 60_000];
const UPDATE_TOAST_DISMISSED_VERSION_KEY = 'opencode-update-toast-dismissed-version';

export const OpenCodeUpdateToast: React.FC = () => {
  const { t } = useI18n();
  const showOpenCodeUpdateNotifications = useUIStore((state) => state.showOpenCodeUpdateNotifications);
  const seenVersionsRef = React.useRef(new Set<string>());
  const upgradingRef = React.useRef(false);

  React.useEffect(() => {
    if (!showOpenCodeUpdateNotifications) {
      toast.dismiss(UPDATE_TOAST_ID);
    }
  }, [showOpenCodeUpdateNotifications]);

  const reloadOpenCode = React.useCallback(() => {
    toast.dismiss(UPGRADE_TOAST_ID);
    void reloadOpenCodeConfiguration({
      message: t('opencodeUpdate.toast.reload.message'),
      mode: 'projects',
      scopes: ['all'],
    }).catch(() => undefined);
  }, [t]);

  const runUpgrade = React.useCallback(async () => {
    if (upgradingRef.current) return;
    upgradingRef.current = true;
    toast.dismiss(UPDATE_TOAST_ID);
    toast.message(t('opencodeUpdate.toast.upgrading.title'), {
      id: UPGRADE_TOAST_ID,
      description: t('opencodeUpdate.toast.upgrading.description'),
      duration: Infinity,
      icon: <Icon name="refresh" className="h-4 w-4 animate-spin text-muted-foreground" />,
    });

    try {
      const version = await runOpenCodeUpgrade(t('opencodeUpdate.toast.failed.description'));

      toast.success(t('opencodeUpdate.toast.updated.title'), {
        id: UPGRADE_TOAST_ID,
        description: version
          ? t('opencodeUpdate.toast.updated.descriptionWithVersion', { version })
          : t('opencodeUpdate.toast.updated.description'),
        duration: Infinity,
        icon: <Icon name="check" className="h-4 w-4 text-[var(--status-success)]" />,
        action: {
          label: t('opencodeUpdate.toast.actions.reload'),
          onClick: reloadOpenCode,
        },
      });
    } catch (error) {
      toast.error(t('opencodeUpdate.toast.failed.title'), {
        id: UPGRADE_TOAST_ID,
        description: error instanceof Error ? error.message : t('opencodeUpdate.toast.failed.description'),
        duration: Infinity,
      });
    } finally {
      upgradingRef.current = false;
    }
  }, [reloadOpenCode, t]);

  React.useEffect(() => {
    // Managed CLI installations upgrade through the host. External runtimes
    // keep the informational toast because the host cannot run their CLI.
    const showUpdateAvailableToast = (version: string, supported: boolean) => {
      // Upstream setting wins over our dedup logic: if user disabled
      // OpenCode update notifications, dismiss any active toast and bail
      // before consulting dedup state.
      if (!useUIStore.getState().showOpenCodeUpdateNotifications) {
        toast.dismiss(UPDATE_TOAST_ID);
        return;
      }
      const decision = shouldShowOpenCodeUpdateToast({
        version,
        dismissedVersion: getDeferredSafeStorage().getItem(UPDATE_TOAST_DISMISSED_VERSION_KEY),
        seenVersions: seenVersionsRef.current,
      });
      if (!decision) {
        return;
      }
      seenVersionsRef.current.add(version);

      const dismiss = {
        label: t('opencodeUpdate.toast.actions.dismiss'),
        onClick: () => {
          getDeferredSafeStorage().setItem(UPDATE_TOAST_DISMISSED_VERSION_KEY, version);
          void updateDesktopSettings({ openCodeUpdateToastDismissedVersion: version });
          toast.dismiss(UPDATE_TOAST_ID);
        },
      };
      // The toast wrapper adds an "OK" action when none is given, so the
      // informational variant makes Dismiss its only button.
      toast.info(t('opencodeUpdate.toast.available.title'), supported
        ? {
          id: UPDATE_TOAST_ID,
          description: t('opencodeUpdate.toast.available.description', { version }),
          duration: Infinity,
          action: { label: t('opencodeUpdate.toast.actions.update'), onClick: runUpgrade },
          cancel: dismiss,
        }
        : {
          id: UPDATE_TOAST_ID,
          description: t('opencodeUpdate.toast.available.manualDescription', { version }),
          duration: Infinity,
          action: dismiss,
        });
    };

    let cancelled = false;
    const timeoutIds: Array<ReturnType<typeof setTimeout>> = [];

    const checkForUpdate = async (attempt: number, runtimeKey = getRuntimeKey()) => {
      try {
        const status = await fetchOpenCodeUpgradeStatus();
        if (!cancelled && runtimeKey === getRuntimeKey() && status.availableVersion) {
          showUpdateAvailableToast(status.availableVersion, status.supported);
        }
      } catch {
        const delay = CHECK_RETRY_DELAYS_MS[attempt];
        if (!cancelled && runtimeKey === getRuntimeKey() && delay !== undefined) {
          timeoutIds.push(setTimeout(() => { void checkForUpdate(attempt + 1, runtimeKey); }, delay));
        }
      }
    };

    const onUpdateAvailable = (event: Event) => {
      const version = resolveOpenCodeUpdateVersion((event as CustomEvent<unknown>).detail);
      if (version) {
        void checkForUpdate(0);
      }
    };

    if (showOpenCodeUpdateNotifications) {
      timeoutIds.push(setTimeout(() => { void checkForUpdate(0); }, INITIAL_CHECK_DELAY_MS));
    }

    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(({ runtimeKey }) => {
      seenVersionsRef.current.clear();
      toast.dismiss(UPDATE_TOAST_ID);
      if (useUIStore.getState().showOpenCodeUpdateNotifications) {
        void checkForUpdate(0, runtimeKey);
      }
    });

    window.addEventListener('openchamber:opencode-update-available', onUpdateAvailable);
    return () => {
      cancelled = true;
      for (const timeoutId of timeoutIds) clearTimeout(timeoutId);
      unsubscribeRuntime();
      window.removeEventListener('openchamber:opencode-update-available', onUpdateAvailable);
    };
  }, [runUpgrade, showOpenCodeUpdateNotifications, t]);

  return null;
};
