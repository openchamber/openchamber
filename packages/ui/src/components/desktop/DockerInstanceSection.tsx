import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { isDesktopShell } from '@/lib/desktop';
import { setRuntimeIdentityOverride } from '@/lib/runtime-switch';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  activateDockerInstance,
  deactivateDockerInstance,
  DOCKER_UPSTREAM_CHANGED_EVENT,
  fetchDockerInstances,
  notifyUpstreamChanged,
  runDockerInstanceAction,
  type DockerInstanceLifecycleState,
  type DockerInstanceRecord,
  type DockerInstancesSnapshot,
} from '@/lib/dockerInstances';
import { DockerInstanceCreateDialog } from './DockerInstanceCreateDialog';

const STATE_LABEL_KEYS = {
  creating: 'dockerInstances.state.creating',
  starting: 'dockerInstances.state.starting',
  probing: 'dockerInstances.state.probing',
  running: 'dockerInstances.state.running',
  stopped: 'dockerInstances.state.stopped',
  error: 'dockerInstances.state.error',
  removing: 'dockerInstances.state.removing',
  'removal-failed': 'dockerInstances.state.removalFailed',
} as const satisfies Record<DockerInstanceLifecycleState, I18nKey>;

const STATE_IN_PROGRESS = new Set<DockerInstanceLifecycleState>(['creating', 'starting', 'probing', 'removing']);

const stateBadgeClass = (state: DockerInstanceLifecycleState) => {
  if (state === 'running') return 'text-[var(--status-success)] bg-[var(--status-success)]/10';
  if (state === 'error' || state === 'removal-failed') return 'text-[var(--status-error)] bg-[var(--status-error)]/10';
  if (STATE_IN_PROGRESS.has(state)) return 'text-[var(--status-info)] bg-[var(--status-info)]/10';
  return 'text-muted-foreground bg-muted';
};

interface DockerInstanceSectionProps {
  /** Refresh the surrounding switcher after lifecycle changes. */
  onChanged?: () => void;
  className?: string;
}

/**
 * Docker-backed OpenCode instances, rendered inside the instance selector.
 * Entirely server-backed (works in the desktop shell AND plain web mode) and
 * self-gating: renders nothing while the OpenChamber feature toggle is off or
 * the server does not answer with the feature enabled.
 */
export function DockerInstanceSection({ onChanged, className }: DockerInstanceSectionProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = React.useState<DockerInstancesSnapshot | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const next = await fetchDockerInstances();
      setSnapshot(next);
      setLoadFailed(false);
      // The active upstream changes what the local server serves WITHOUT
      // changing the client origin, so caches and stores keyed by the runtime
      // identity must be re-scoped whenever the active instance moves.
      setRuntimeIdentityOverride(
        next.enabled && next.activeInstanceId
          ? `local-docker-${next.activeInstanceId}`
          : null,
      );
      return next;
    } catch {
      // Authoritative failure stays visible (retry affordance below) instead
      // of masquerading as an empty feature.
      setLoadFailed(true);
      return null;
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const next = await refresh();
      if (!cancelled && next && !next.enabled) {
        // Feature is off: stop polling and hide the section entirely.
        setSnapshot(next);
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 5000);
    // The active upstream can change from OTHER surfaces (desktop host
    // switcher deactivating it, API calls) — re-sync identity from server
    // truth whenever that happens.
    const onChanged = () => void poll();
    window.addEventListener(DOCKER_UPSTREAM_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(DOCKER_UPSTREAM_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);

  // Feature off or nothing loaded yet: hide, EXCEPT when the authoritative
  // load failed — then surface a retry instead of silently rendering nothing.
  if (!snapshot || !snapshot.enabled) {
    if (loadFailed) {
      return (
        <div className={cn('pt-2', className)}>
          <div className="mx-2 mb-1 flex items-center justify-between gap-2 rounded-md border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 px-2 py-1.5">
            <span className="typography-micro text-[var(--status-error)]">{t('dockerInstances.state.loadFailed')}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => void refresh()}>
              {t('desktopHostSwitcher.actions.retry')}
            </Button>
          </div>
        </div>
      );
    }
    return null;
  }

  const handleAction = async (instance: DockerInstanceRecord, action: 'start' | 'stop' | 'cleanup') => {
    setBusyId(instance.id);
    try {
      await runDockerInstanceAction(instance.id, action);
      if (action === 'stop') toast.success(t('dockerInstances.toast.stopped', { name: instance.label }));
      await refresh();
      onChanged?.();
      notifyUpstreamChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('dockerInstances.toast.actionFailed'));
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  const handleRemove = async (instance: DockerInstanceRecord) => {
    if (confirmingId !== instance.id) {
      setConfirmingId(instance.id);
      return;
    }
    setBusyId(instance.id);
    try {
      await runDockerInstanceAction(instance.id, 'remove');
      toast.success(t('dockerInstances.toast.removed', { name: instance.label }));
      await refresh();
      onChanged?.();
      notifyUpstreamChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('dockerInstances.toast.actionFailed'));
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  const handleSwitch = async (instance: DockerInstanceRecord) => {
    const isActive = snapshot.activeInstanceId === instance.id;
    setBusyId(instance.id);
    try {
      if (isActive) {
        await deactivateDockerInstance();
        toast.success(t('dockerInstances.toast.deactivated'));
      } else {
        await activateDockerInstance(instance.id);
        toast.success(t('dockerInstances.toast.activated', { name: instance.label }));
      }
      await refresh();
      onChanged?.();
      notifyUpstreamChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('dockerInstances.toast.actionFailed'));
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={cn('pt-2', className)}>
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="typography-meta font-medium text-muted-foreground uppercase tracking-wide">
          {t('dockerInstances.title')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setCreateOpen(true)}
        >
          <Icon name="add" className="h-3.5 w-3.5" />
          {t('dockerInstances.actions.addDocker')}
        </Button>
      </div>

      {loadFailed && (
        <div className="mx-2 mb-1 flex items-center justify-between gap-2 rounded-md border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 px-2 py-1.5">
          <span className="typography-micro text-[var(--status-error)]">{t('dockerInstances.state.loadFailed')}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => void refresh()}>
            {t('desktopHostSwitcher.actions.retry')}
          </Button>
        </div>
      )}

      <div className="space-y-1">
        {snapshot.instances.length === 0 && (
          <div className="px-2 py-1.5 typography-micro text-muted-foreground">
            {t('dockerInstances.state.empty')}
          </div>
        )}
        {snapshot.instances.map((instance) => {
          const isActive = snapshot.activeInstanceId === instance.id;
          const busy = busyId === instance.id;
          const inProgress = STATE_IN_PROGRESS.has(instance.lifecycleState);
          return (
            <div
              key={instance.id}
              className={cn(
                'group rounded-xl px-3 py-2.5',
                isActive ? 'bg-[var(--interactive-selection)]/25' : 'bg-[var(--surface-muted)] hover:bg-interactive-hover/30',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full flex-shrink-0', instance.lifecycleState === 'running' ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/40')} />
                <button
                  type="button"
                  className="flex-1 min-w-0 text-left"
                  onClick={() => void handleSwitch(instance)}
                  disabled={busy || instance.lifecycleState !== 'running'}
                  aria-label={t('dockerInstances.actions.switchAria', { name: instance.label })}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="typography-ui-label font-medium truncate text-foreground">{instance.label}</span>
                    {isActive && (
                      <span className="typography-micro flex-shrink-0 text-muted-foreground bg-muted px-1 rounded leading-none pb-px border border-border/50">
                        {t('desktopHostSwitcher.header.current')}
                      </span>
                    )}
                    <span className={cn('typography-micro flex-shrink-0 px-1 rounded leading-none pb-px', stateBadgeClass(instance.lifecycleState))}>
                      {t(STATE_LABEL_KEYS[instance.lifecycleState])}
                    </span>
                  </div>
                  <div className="typography-micro text-muted-foreground/70 truncate font-mono">
                    {instance.workspaceHostPath}
                  </div>
                  {instance.lastError && (
                    <div className="typography-micro text-[var(--status-error)] truncate">{instance.lastError}</div>
                  )}
                </button>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {busy || inProgress ? (
                    <Icon name="loader-4" className="h-4 w-4 text-muted-foreground animate-spin" />
                  ) : null}
                  {!busy && !inProgress && instance.lifecycleState === 'running' && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => void handleAction(instance, 'stop')} aria-label={t('dockerInstances.actions.stop')}>
                      <Icon name="pause" className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {!busy && !inProgress && instance.lifecycleState === 'stopped' && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => void handleAction(instance, 'start')} aria-label={t('dockerInstances.actions.start')}>
                      <Icon name="play" className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {!busy && !inProgress && (instance.lifecycleState === 'removal-failed' || instance.lifecycleState === 'error') && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => void handleAction(instance, 'cleanup')} aria-label={t('dockerInstances.actions.cleanup')}>
                      <Icon name="restart" className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {!busy && !inProgress && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className={confirmingId === instance.id ? 'text-[var(--status-error)]' : undefined}
                      onClick={() => void handleRemove(instance)}
                      aria-label={confirmingId === instance.id ? t('dockerInstances.actions.confirmRemove') : t('dockerInstances.actions.remove')}
                    >
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                      {confirmingId === instance.id ? <span className="typography-micro">{t('dockerInstances.actions.confirmRemove')}</span> : null}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <DockerInstanceCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        snapshot={snapshot}
        onCreated={() => {
          void refresh();
          onChanged?.();
        }}
      />
    </div>
  );
}

/**
 * Label of the currently active Docker instance (null when Local/external is
 * active or the feature is off). Refreshes on upstream-change events and on a
 * slow poll so header surfaces stay truthful without user interaction.
 */
export function useActiveDockerInstanceLabel(): string | null {
  const [label, setLabel] = React.useState<string | null>(null);
  // Re-discovery cadence while the feature is known to be OFF: the identity
  // event cannot fire (nothing is managing instances), so a slow poll is the
  // only way the label learns the toggle was turned back on. Fast cadence is
  // only needed while instances exist.
  const refresh = React.useCallback(async (): Promise<boolean> => {
    try {
      const snapshot = await fetchDockerInstances();
      const active = snapshot.enabled && snapshot.activeInstanceId
        ? snapshot.instances.find((instance) => instance.id === snapshot.activeInstanceId) ?? null
        : null;
      setLabel(active?.label ?? null);
      return snapshot.enabled;
    } catch {
      setLabel(null);
      return false;
    }
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const onChanged = () => void refresh();
    const tick = async () => {
      const enabled = await refresh();
      if (cancelled) return;
      timer = window.setTimeout(() => void tick(), enabled ? 15_000 : 60_000);
    };
    window.addEventListener(DOCKER_UPSTREAM_CHANGED_EVENT, onChanged);
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener(DOCKER_UPSTREAM_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);
  return label;
}

/**
 * Web-mode entry point: a dedicated trigger for the docker section in runtimes
 * without the desktop instance switcher. Renders nothing on the desktop shell
 * (the section already lives inside DesktopHostSwitcherDialog) and nothing
 * while the feature toggle is off.
 */
export function DockerInstancesWebEntry({ variant = 'button' }: { variant?: 'button' | 'icon' }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [available, setAvailable] = React.useState(false);

  React.useEffect(() => {
    if (isDesktopShell()) return;
    let cancelled = false;
    void fetchDockerInstances()
      .then((snapshot) => {
        if (!cancelled) setAvailable(snapshot.enabled);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isDesktopShell() || !available) {
    return null;
  }

  return (
    <>
      {variant === 'icon' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-oc-docker-instances
          onClick={() => setOpen(true)}
          aria-label={t('dockerInstances.actions.openAria')}
        >
          <Icon name="server" className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-oc-docker-instances
          className="w-full justify-center"
          onClick={() => setOpen(true)}
        >
          <Icon name="server" className="h-4 w-4" />
          {t('dockerInstances.title')}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(30rem,calc(100vw-2rem))] max-w-none max-h-[70vh] flex flex-col overflow-hidden gap-2">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Icon name="server" className="h-5 w-5" />
              {t('dockerInstances.title')}
            </DialogTitle>
            <DialogDescription>
              {t('dockerInstances.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <DockerInstanceSection />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
