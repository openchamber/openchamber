import React from 'react';
import { isDesktopShell, restartDesktopApp } from '@/lib/desktop';
import { DesktopConnectionRecovery, type RecoveryVariant, type ServerUpdateState } from './DesktopConnectionRecovery';
import { RemoteConnectionForm } from './RemoteConnectionForm';
import { resolveRecoveryNextStep } from './desktopRecoveryRouting';
import { desktopHostsGet, desktopHostsSet, desktopHostUpdateServer, normalizeHostUrl, waitForDesktopHostUpdated } from '@/lib/desktopHosts';
import { runtimeFetch } from '@/lib/runtime-fetch';

type RecoveryScreenProps = {
  variant: RecoveryVariant;
  hostUrl?: string;
  hostLabel?: string;
  hostId?: string;
  onRetry?: () => void;
  onChooseRemote?: () => void;
  showRemoteForm?: boolean;
  onCloseRemoteForm?: () => void;
  onSwitchToLocalFromRemote?: () => void;
  onEnterLocalSetup?: () => void;
  isRetrying?: boolean;
  localAvailable?: boolean;
};

export function RecoveryScreen({
  variant,
  hostUrl,
  hostLabel,
  hostId,
  onRetry,
  onChooseRemote,
  showRemoteForm = false,
  onCloseRemoteForm,
  onSwitchToLocalFromRemote,
  onEnterLocalSetup,
  isRetrying = false,
  localAvailable = true,
}: RecoveryScreenProps) {
  const persistFirstChoice = React.useCallback(async (choice: 'local' | 'remote') => {
    if (!isDesktopShell()) return;

    const config = await desktopHostsGet();
    await desktopHostsSet({
      ...config,
      ...(choice === 'local' ? { defaultHostId: 'local' } : {}),
      initialHostChoiceCompleted: true,
    });
  }, []);

  const handleRecoveryRetry = React.useCallback(async () => {
    if (isDesktopShell()) {
      await restartDesktopApp();
      return;
    }

    await runtimeFetch('/api/config/reload', { method: 'POST' });
    onRetry?.();
  }, [onRetry]);

  const handleRecoveryUseLocal = React.useCallback(async () => {
    const step = resolveRecoveryNextStep(variant, 'use-local');
    if (step.kind === 'local-setup') {
      onEnterLocalSetup?.();
      return;
    }
    await persistFirstChoice('local');

    if (isDesktopShell()) {
      await restartDesktopApp();
      return;
    }

    window.location.reload();
  }, [variant, persistFirstChoice, onEnterLocalSetup]);

  const [serverUpdate, setServerUpdate] = React.useState<ServerUpdateState>({ kind: 'idle' });

  const [updatableHostId, setUpdatableHostId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setUpdatableHostId(null);
    if (variant !== 'remote-incompatible' || !hostId || !isDesktopShell()) return;
    let cancelled = false;
    void desktopHostsGet().then((config) => {
      const host = config.hosts.find((entry) => entry.id === hostId);
      const directUrl = normalizeHostUrl(host?.apiUrl || host?.url || '');
      if (!cancelled && directUrl) setUpdatableHostId(hostId);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [variant, hostId]);

  const handleUpdateServer = React.useCallback(async (targetHostId: string) => {
    setServerUpdate({ kind: 'updating' });
    try {
      const result = await desktopHostUpdateServer(targetHostId);
      if (result.status === 'auth') {
        setServerUpdate({ kind: 'auth' });
        return;
      }
      if (result.status === 'failed') {
        setServerUpdate({ kind: 'refused', error: result.error });
        return;
      }
      if (await waitForDesktopHostUpdated(targetHostId) === 'timeout') {
        setServerUpdate({ kind: 'timeout' });
        return;
      }
      if (!await restartDesktopApp()) setServerUpdate({ kind: 'idle' });
    } catch {
      setServerUpdate({ kind: 'timeout' });
    }
  }, []);

  const handleRecoveryUseRemote = React.useCallback(() => {
    const step = resolveRecoveryNextStep(variant, 'use-remote');
    if (step.kind === 'remote-form') {
      onChooseRemote?.();
    }
  }, [variant, onChooseRemote]);

  if (showRemoteForm) {
    const prefillUrl = variant === 'remote-wrong-service' ? '' : (hostUrl || '');
    const prefillLabel = variant === 'remote-wrong-service' ? '' : (hostLabel || '');
    return (
      <RemoteConnectionForm
        onBack={onCloseRemoteForm || (() => onChooseRemote?.())}
        initialUrl={prefillUrl}
        initialLabel={prefillLabel}
        isRecoveryMode={true}
        showInstancePicker={!localAvailable}
        onSwitchToLocal={localAvailable ? (onSwitchToLocalFromRemote || (() => {
          persistFirstChoice('local').then(() => {
            if (isDesktopShell()) {
              restartDesktopApp();
            } else {
              onEnterLocalSetup?.();
            }
          });
        })) : undefined}
      />
    );
  }

  return (
    <DesktopConnectionRecovery
      variant={variant}
      hostLabel={hostLabel}
      hostUrl={hostUrl}
      onRetry={handleRecoveryRetry}
      onUseLocal={localAvailable ? handleRecoveryUseLocal : undefined}
      onUseRemote={handleRecoveryUseRemote}
      isRetrying={isRetrying}
      onUpdateServer={updatableHostId ? () => void handleUpdateServer(updatableHostId) : undefined}
      serverUpdate={serverUpdate}
    />
  );
}
