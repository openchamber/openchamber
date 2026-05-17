import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

type OpenCodeUpdateAvailableEvent = CustomEvent<{ version?: unknown }>;
type OpenCodeUpgradeStatus = {
  available?: boolean | null;
  latestVersion?: string | null;
};

const UPDATE_TOAST_ID = 'opencode-update-available';
const UPGRADE_TOAST_ID = 'opencode-upgrade-progress';
const INITIAL_CHECK_DELAY_MS = 5_000;
const CHECK_RETRY_DELAYS_MS = [10_000, 60_000];

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
    });
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
      const response = await fetch('/api/opencode/upgrade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => null) as null | { success?: boolean; version?: string; error?: string };
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || response.statusText || t('opencodeUpdate.toast.failed.description'));
      }

      toast.success(t('opencodeUpdate.toast.updated.title'), {
        id: UPGRADE_TOAST_ID,
        description: payload?.version
          ? t('opencodeUpdate.toast.updated.descriptionWithVersion', { version: payload.version })
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
    const showUpdateAvailableToast = (version: string) => {
      if (!useUIStore.getState().showOpenCodeUpdateNotifications) {
        toast.dismiss(UPDATE_TOAST_ID);
        return;
      }
      if (!version) {
        return;
      }
      if (seenVersionsRef.current.has(version)) {
        return;
      }
      seenVersionsRef.current.add(version);

      toast.info(t('opencodeUpdate.toast.available.title'), {
        id: UPDATE_TOAST_ID,
        description: t('opencodeUpdate.toast.available.description', { version }),
        duration: Infinity,
        action: {
          label: t('opencodeUpdate.toast.actions.update'),
          onClick: runUpgrade,
        },
      });
    };

    const onUpdateAvailable = (event: Event) => {
      const version = typeof (event as OpenCodeUpdateAvailableEvent).detail?.version === 'string'
        ? String((event as OpenCodeUpdateAvailableEvent).detail.version).trim()
        : '';
      showUpdateAvailableToast(version);
    };

    let cancelled = false;
    const timeoutIds: Array<ReturnType<typeof setTimeout>> = [];

    const checkForUpdate = async (attempt: number) => {
      try {
        const response = await fetch('/api/opencode/upgrade-status', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(response.statusText || 'OpenCode upgrade status check failed');
        const status = await response.json().catch(() => null) as OpenCodeUpgradeStatus | null;
        const version = typeof status?.latestVersion === 'string' ? status.latestVersion.trim() : '';
        if (!cancelled && status?.available === true && version) {
          showUpdateAvailableToast(version);
        }
      } catch {
        const delay = CHECK_RETRY_DELAYS_MS[attempt];
        if (!cancelled && delay !== undefined) {
          timeoutIds.push(setTimeout(() => { void checkForUpdate(attempt + 1); }, delay));
        }
      }
    };

    if (showOpenCodeUpdateNotifications) {
      timeoutIds.push(setTimeout(() => { void checkForUpdate(0); }, INITIAL_CHECK_DELAY_MS));
    }

    window.addEventListener('openchamber:opencode-update-available', onUpdateAvailable);
    return () => {
      cancelled = true;
      for (const timeoutId of timeoutIds) clearTimeout(timeoutId);
      window.removeEventListener('openchamber:opencode-update-available', onUpdateAvailable);
    };
  }, [runUpgrade, showOpenCodeUpdateNotifications, t]);

  return null;
};
