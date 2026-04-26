import React from 'react';
import { RiAddLine, RiDeleteBinLine, RiPlug2Line, RiRefreshLine, RiStopLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import type { DesktopSshInstance } from '@/lib/desktopSsh';
import { useI18n } from '@/lib/i18n';

type RemoteInstancesSidebarProps = {
  onItemSelect?: () => void;
};

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const randomPort = (): number => {
  return Math.floor(20000 + Math.random() * 30000);
};

const isPortInUseError = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('address already in use') || message.includes('eaddrinuse') || message.includes('port already in use');
};

const phaseLabelKey = (phase?: string) => {
  switch (phase) {
    case 'ready':
      return 'settings.remoteInstances.sidebar.phase.ready';
    case 'error':
      return 'settings.remoteInstances.sidebar.phase.error';
    case 'degraded':
      return 'settings.remoteInstances.sidebar.phase.reconnect';
    case 'installing':
      return 'settings.remoteInstances.sidebar.phase.installing';
    case 'updating':
      return 'settings.remoteInstances.sidebar.phase.updating';
    case 'forwarding':
      return 'settings.remoteInstances.sidebar.phase.forwarding';
    case 'server_starting':
      return 'settings.remoteInstances.sidebar.phase.starting';
    case 'master_connecting':
      return 'settings.remoteInstances.sidebar.phase.connecting';
    default:
      return 'settings.remoteInstances.sidebar.phase.idle';
  }
};

export const RemoteInstancesSidebar: React.FC<RemoteInstancesSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const instances = useDesktopSshStore((state) => state.instances);
  const statusesById = useDesktopSshStore((state) => state.statusesById);
  const isLoading = useDesktopSshStore((state) => state.isLoading);
  const load = useDesktopSshStore((state) => state.load);
  const loadImports = useDesktopSshStore((state) => state.loadImports);
  const createFromCommand = useDesktopSshStore((state) => state.createFromCommand);
  const connect = useDesktopSshStore((state) => state.connect);
  const disconnect = useDesktopSshStore((state) => state.disconnect);
  const retry = useDesktopSshStore((state) => state.retry);
  const removeInstance = useDesktopSshStore((state) => state.removeInstance);
  const upsertInstance = useDesktopSshStore((state) => state.upsertInstance);

  const selectedId = useUIStore((state) => state.settingsRemoteInstancesSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsRemoteInstancesSelectedId);

  React.useEffect(() => {
    void load();
    void loadImports();
  }, [load, loadImports]);

  React.useEffect(() => {
    if (isLoading) return;
    if (instances.length === 0) {
      if (selectedId !== null) {
        setSelectedId(null);
      }
      return;
    }
    if (selectedId && instances.some((instance) => instance.id === selectedId)) {
      return;
    }
    setSelectedId(instances[0].id);
  }, [instances, isLoading, selectedId, setSelectedId]);

  const handleAdd = React.useCallback(async () => {
    const id = makeId();
    try {
      await createFromCommand(id, 'ssh user@example.com', t('settings.remoteInstances.sidebar.newSshInstanceName'));
      setSelectedId(id);
      onItemSelect?.();
    } catch (error) {
      toast.error(t('settings.remoteInstances.sidebar.toast.createFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [createFromCommand, onItemSelect, setSelectedId, t]);

  const connectWithPortRecovery = React.useCallback(async (instance: DesktopSshInstance) => {
    try {
      await connect(instance.id);
      return;
    } catch (error) {
      if (!isPortInUseError(error)) {
        throw error;
      }

      const allow = window.confirm(t('settings.remoteInstances.sidebar.confirm.localPortInUseRetry'));
      if (!allow) {
        throw error;
      }

      const nextInstance: DesktopSshInstance = {
        ...instance,
        localForward: {
          ...instance.localForward,
          preferredLocalPort: randomPort(),
        },
      };

      await upsertInstance(nextInstance);
      await connect(nextInstance.id);
      toast.success(t('settings.remoteInstances.sidebar.toast.retriedWithRandomPort'));
    }
  }, [connect, t, upsertInstance]);

  return (
    <SettingsSidebarLayout
      variant="background"
      header={
        <div className="border-b px-3 pt-4 pb-3">
          <h2 className="text-base font-semibold text-foreground mb-3">{t('settings.remoteInstances.sidebar.title')}</h2>
          <div className="flex items-center justify-between gap-2">
            <span className="typography-meta text-muted-foreground">{t('settings.remoteInstances.sidebar.total', { count: instances.length })}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 -my-1 text-muted-foreground"
              onClick={() => void handleAdd()}
              aria-label={t('settings.remoteInstances.sidebar.actions.addSshInstance')}
            >
              <RiAddLine className="size-4" />
            </Button>
          </div>
        </div>
      }
    >
      {instances.map((instance) => {
        const status = statusesById[instance.id];
        const selected = instance.id === selectedId;
        const title = instance.nickname?.trim() || instance.sshParsed?.destination || instance.id;
        const metadata = `${t(phaseLabelKey(status?.phase))}${status?.localUrl ? ` · ${status.localUrl}` : ''}`;
        const isReady = status?.phase === 'ready';
        const canRetry = status?.phase === 'error' || status?.phase === 'degraded';

        return (
          <SettingsSidebarItem
            key={instance.id}
            title={title}
            metadata={metadata}
            selected={selected}
            onSelect={() => {
              setSelectedId(instance.id);
              onItemSelect?.();
            }}
            actions={[
              {
                label: isReady ? t('settings.remoteInstances.sidebar.actions.disconnect') : t('settings.remoteInstances.sidebar.actions.connect'),
                icon: isReady ? RiStopLine : RiPlug2Line,
                onClick: () => {
                  const op = isReady ? disconnect(instance.id) : connectWithPortRecovery(instance);
                  void op.catch((error) => {
                    toast.error(
                      isReady
                        ? t('settings.remoteInstances.sidebar.toast.disconnectFailed')
                        : t('settings.remoteInstances.sidebar.toast.connectFailed'),
                      {
                      description: error instanceof Error ? error.message : String(error),
                      }
                    );
                  });
                },
              },
              {
                label: t('settings.remoteInstances.sidebar.actions.retry'),
                icon: RiRefreshLine,
                onClick: () => {
                  if (!canRetry) return;
                  void retry(instance.id).catch((error) => {
                    toast.error(t('settings.remoteInstances.sidebar.toast.retryFailed'), {
                      description: error instanceof Error ? error.message : String(error),
                    });
                  });
                },
              },
              {
                label: t('settings.remoteInstances.sidebar.actions.remove'),
                icon: RiDeleteBinLine,
                destructive: true,
                onClick: () => {
                  void removeInstance(instance.id).then(() => {
                    if (selectedId === instance.id) {
                      const next = instances.find((item) => item.id !== instance.id);
                      setSelectedId(next?.id || null);
                    }
                  }).catch((error) => {
                    toast.error(t('settings.remoteInstances.sidebar.toast.removeFailed'), {
                      description: error instanceof Error ? error.message : String(error),
                    });
                  });
                },
              },
            ]}
          />
        );
      })}
    </SettingsSidebarLayout>
  );
};
