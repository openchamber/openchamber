import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  RiAddLine,
  RiCheckLine,
  RiCloudOffLine,
  RiEarthLine,
  RiLoader4Line,
  RiMore2Line,
  RiPencilLine,
  RiPlug2Line,
  RiRefreshLine,
  RiServerLine,
  RiSettings3Line,
  RiShieldKeyholeLine,
  RiStarFill,
  RiStarLine,
  RiDeleteBinLine,
  RiWindowLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { isTauriShell, isDesktopShell } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopOpenNewWindowAtUrl,
  locationMatchesHost,
  normalizeHostUrl,
  redactSensitiveUrl,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import {
  desktopSshConnect,
  desktopSshDisconnect,
  desktopSshInstancesGet,
  desktopSshStatus,
  type DesktopSshInstanceStatus,
} from '@/lib/desktopSsh';

const LOCAL_HOST_ID = 'local';
const SSH_CONNECT_TIMEOUT_MS = 90_000;
const SSH_CONNECT_CANCELLED_ERROR = 'SSH connection cancelled';

type HostStatus = {
  status: HostProbeResult['status'];
  latencyMs: number;
};

const toNavigationUrl = (rawUrl: string): string => {
  const normalized = normalizeHostUrl(rawUrl);
  if (!normalized) {
    return rawUrl.trim();
  }

  try {
    const url = new URL(normalized);
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return normalized;
  }
};

const getLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;
};

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const statusDotClass = (status: HostProbeResult['status'] | null): string => {
  if (status === 'ok') return 'bg-status-success';
  if (status === 'auth') return 'bg-status-warning';
  if (status === 'unreachable') return 'bg-status-error';
  return 'bg-muted-foreground/40';
};

const statusLabel = (status: HostProbeResult['status'] | null): string => {
  if (status === 'ok') return 'Connected';
  if (status === 'auth') return 'Auth required';
  if (status === 'unreachable') return 'Unreachable';
  return 'Unknown';
};

const statusIcon = (status: HostProbeResult['status'] | null) => {
  if (status === 'ok') return <RiCheckLine className="h-4 w-4" />;
  if (status === 'auth') return <RiShieldKeyholeLine className="h-4 w-4" />;
  if (status === 'unreachable') return <RiCloudOffLine className="h-4 w-4" />;
  return <RiEarthLine className="h-4 w-4" />;
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const sshPhaseLabel = (phase: DesktopSshInstanceStatus['phase'] | undefined): string => {
  switch (phase) {
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Error';
    case 'degraded':
      return 'Reconnecting';
    case 'config_resolved':
      return 'Resolving config';
    case 'auth_check':
      return 'Checking auth';
    case 'master_connecting':
      return 'Connecting SSH';
    case 'remote_probe':
      return 'Probing remote';
    case 'installing':
      return 'Installing';
    case 'updating':
      return 'Updating';
    case 'server_detecting':
      return 'Detecting server';
    case 'server_starting':
      return 'Starting server';
    case 'forwarding':
      return 'Forwarding ports';
    default:
      return 'Idle';
  }
};

const sshPhaseToHostStatus = (
  phase: DesktopSshInstanceStatus['phase'] | undefined,
): HostProbeResult['status'] | null => {
  if (!phase || phase === 'idle') return null;
  if (phase === 'ready') return 'ok';
  if (phase === 'error') return 'unreachable';
  return 'auth';
};

const getSshStatusById = async (): Promise<Record<string, DesktopSshInstanceStatus>> => {
  const statuses = await desktopSshStatus().catch(() => []);
  const next: Record<string, DesktopSshInstanceStatus> = {};
  for (const status of statuses) {
    next[status.id] = status;
  }
  return next;
};

const waitForSshReady = async (
  id: string,
  timeoutMs: number,
  onUpdate: (status: DesktopSshInstanceStatus) => void,
  shouldCancel?: () => boolean,
): Promise<DesktopSshInstanceStatus> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldCancel?.()) {
      throw new Error(SSH_CONNECT_CANCELLED_ERROR);
    }

    const statuses = await desktopSshStatus(id).catch(() => []);
    const status = statuses.find((item) => item.id === id);
    if (status) {
      onUpdate(status);
      if (status.phase === 'ready') {
        return status;
      }
      if (status.phase === 'error') {
        throw new Error(status.detail || 'SSH connection failed');
      }
    }
    await sleep(700);
  }

  if (shouldCancel?.()) {
    throw new Error(SSH_CONNECT_CANCELLED_ERROR);
  }

  throw new Error('Timed out waiting for SSH connection');
};

const buildLocalHost = (): DesktopHost => ({
  id: LOCAL_HOST_ID,
  label: 'Local',
  url: getLocalOrigin(),
});

const resolveCurrentHost = (hosts: DesktopHost[]) => {
  const currentHref = typeof window === 'undefined' ? '' : window.location.href;
  const localOrigin = getLocalOrigin();
  const normalizedLocal = normalizeHostUrl(localOrigin) || localOrigin;
  const normalizedCurrent = normalizeHostUrl(currentHref) || currentHref;

  if (currentHref && locationMatchesHost(currentHref, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const match = hosts.find((h) => {
    return currentHref ? locationMatchesHost(currentHref, h.url) : false;
  });

  if (match) {
    return { id: match.id, label: match.label, url: normalizeHostUrl(match.url) || match.url };
  }

  return {
    id: 'custom',
    label: redactSensitiveUrl(normalizedCurrent || 'Instance'),
    url: normalizedCurrent,
  };
};

type DesktopHostSwitcherDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  embedded?: boolean;
  onHostSwitched?: () => void;
};

export function DesktopHostSwitcherDialog({
  open,
  onOpenChange,
  embedded = false,
  onHostSwitched,
}: DesktopHostSwitcherDialogProps) {
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);

  const [configHosts, setConfigHosts] = React.useState<DesktopHost[]>([]);
  const [defaultHostId, setDefaultHostId] = React.useState<string | null>(null);
  const [statusById, setStatusById] = React.useState<Record<string, HostStatus>>({});
  const [isLoading, setIsLoading] = React.useState(false);
  const [isProbing, setIsProbing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [switchingHostId, setSwitchingHostId] = React.useState<string | null>(null);
  const [sshHostIds, setSshHostIds] = React.useState<Record<string, true>>({});
  const [sshStatusesById, setSshStatusesById] = React.useState<Record<string, DesktopSshInstanceStatus>>({});
  const [sshSwitchModal, setSshSwitchModal] = React.useState<{
    open: boolean;
    hostId: string | null;
    hostLabel: string;
    phase: DesktopSshInstanceStatus['phase'] | 'idle';
    detail: string | null;
    error: string | null;
  }>({
    open: false,
    hostId: null,
    hostLabel: '',
    phase: 'idle',
    detail: null,
    error: null,
  });
  const [error, setError] = React.useState<string>('');

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState('');
  const [editUrl, setEditUrl] = React.useState('');

  const [newLabel, setNewLabel] = React.useState('');
  const [newUrl, setNewUrl] = React.useState('');
  const [isAddFormOpen, setIsAddFormOpen] = React.useState(!embedded);
  const sshSwitchTokenRef = React.useRef(0);

  const allHosts = React.useMemo(() => {
    const local = buildLocalHost();
    const normalizedRemote = configHosts.map((h) => ({
      ...h,
      url: normalizeHostUrl(h.url) || h.url,
    }));
    return [local, ...normalizedRemote];
  }, [configHosts]);

  const current = React.useMemo(() => resolveCurrentHost(allHosts), [allHosts]);
  const currentDefaultLabel = React.useMemo(() => {
    const id = defaultHostId || LOCAL_HOST_ID;
    return allHosts.find((h) => h.id === id)?.label || 'Local';
  }, [allHosts, defaultHostId]);

  const persist = React.useCallback(async (nextHosts: DesktopHost[], nextDefaultHostId: string | null) => {
    if (!isTauriShell()) return;
    setIsSaving(true);
    setError('');
    try {
      const remote = nextHosts.filter((h) => h.id !== LOCAL_HOST_ID);
      await desktopHostsSet({ hosts: remote, defaultHostId: nextDefaultHostId });
      setConfigHosts(remote);
      setDefaultHostId(nextDefaultHostId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  }, []);

  const openRemoteInstancesSettings = React.useCallback(() => {
    setSettingsPage('remote-instances');
    setSettingsDialogOpen(true);
    onOpenChange(false);
  }, [onOpenChange, setSettingsDialogOpen, setSettingsPage]);

  const refresh = React.useCallback(async () => {
    if (!isTauriShell()) return;
    setIsLoading(true);
    setError('');
    try {
      const [cfg, sshCfg, sshStatusMap] = await Promise.all([
        desktopHostsGet(),
        desktopSshInstancesGet().catch(() => ({ instances: [] })),
        getSshStatusById(),
      ]);
      const nextSshHostIds: Record<string, true> = {};
      for (const instance of sshCfg.instances) {
        nextSshHostIds[instance.id] = true;
      }
      setConfigHosts(cfg.hosts || []);
      setDefaultHostId(cfg.defaultHostId ?? null);
      setSshHostIds(nextSshHostIds);
      setSshStatusesById(sshStatusMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      setConfigHosts([]);
      setDefaultHostId(null);
      setSshHostIds({});
      setSshStatusesById({});
    } finally {
      setIsLoading(false);
    }
  }, []);

  const probeAll = React.useCallback(async (hosts: DesktopHost[]) => {
    if (!isTauriShell()) return;
    setIsProbing(true);
    try {
      const results = await Promise.all(
        hosts.map(async (h) => {
          const url = normalizeHostUrl(h.url);
          if (!url) {
            return [h.id, { status: 'unreachable' as const, latencyMs: 0 } satisfies HostStatus] as const;
          }
          const res = await desktopHostProbe(url).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
          return [h.id, { status: res.status, latencyMs: res.latencyMs } satisfies HostStatus] as const;
        })
      );
      const next: Record<string, HostStatus> = {};
      for (const [id, val] of results) {
        next[id] = val;
      }
      setStatusById(next);
    } finally {
      setIsProbing(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      setEditingId(null);
      setEditLabel('');
      setEditUrl('');
      setNewLabel('');
      setNewUrl('');
      setIsAddFormOpen(!embedded);
      setSwitchingHostId(null);
      setSshSwitchModal({ open: false, hostId: null, hostLabel: '', phase: 'idle', detail: null, error: null });
      setError('');
      return;
    }
    void refresh();
  }, [embedded, open, refresh]);

  React.useEffect(() => {
    if (!open) return;
    void probeAll(allHosts);
  }, [open, allHosts, probeAll]);

  React.useEffect(() => {
    if (!open || !isTauriShell()) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      const statuses = await getSshStatusById();
      if (!cancelled) {
        setSshStatusesById(statuses);
      }
    };
    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 1_500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open]);

  const handleSwitch = React.useCallback(async (host: DesktopHost) => {
    const origin = host.id === LOCAL_HOST_ID ? getLocalOrigin() : (normalizeHostUrl(host.url) || '');
    if (!origin) return;

    const isSshHost = Boolean(sshHostIds[host.id]);

    if (host.id !== LOCAL_HOST_ID && isSshHost && isTauriShell()) {
      let existingStatus = sshStatusesById[host.id];
      const latestStatus = await desktopSshStatus(host.id)
        .then((items) => items.find((item) => item.id === host.id) || null)
        .catch(() => null);
      if (latestStatus) {
        existingStatus = latestStatus;
        setSshStatusesById((prev) => ({
          ...prev,
          [host.id]: latestStatus,
        }));
      }

      const existingUrl = normalizeHostUrl(existingStatus?.localUrl || host.url || '');
      if (existingStatus?.phase === 'ready' && existingUrl) {
        const target = toNavigationUrl(existingUrl);
        onHostSwitched?.();
        window.location.assign(target);
        return;
      }

      setSwitchingHostId(host.id);
      const switchToken = sshSwitchTokenRef.current + 1;
      sshSwitchTokenRef.current = switchToken;
      setSshSwitchModal({
        open: true,
        hostId: host.id,
        hostLabel: redactSensitiveUrl(host.label),
        phase: 'master_connecting',
        detail: null,
        error: null,
      });
      try {
        await desktopSshConnect(host.id);
        if (switchToken !== sshSwitchTokenRef.current) {
          return;
        }

        const readyStatus = await waitForSshReady(host.id, SSH_CONNECT_TIMEOUT_MS, (status) => {
          setSshStatusesById((prev) => ({
            ...prev,
            [status.id]: status,
          }));
          setSshSwitchModal((prev) => ({
            ...prev,
            phase: status.phase,
            detail: status.detail || null,
          }));
        }, () => switchToken !== sshSwitchTokenRef.current);

        if (switchToken !== sshSwitchTokenRef.current) {
          return;
        }

        const targetOrigin = normalizeHostUrl(readyStatus.localUrl || '') || origin;
        const target = toNavigationUrl(targetOrigin);
        onHostSwitched?.();
        window.location.assign(target);
        return;
      } catch (err) {
        if (switchToken !== sshSwitchTokenRef.current) {
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        if (message === SSH_CONNECT_CANCELLED_ERROR) {
          return;
        }

        setSshSwitchModal((prev) => ({
          ...prev,
          error: message,
        }));
        toast.error(`SSH instance "${redactSensitiveUrl(host.label)}" failed to connect`, {
          description: message,
        });
        return;
      } finally {
        if (switchToken === sshSwitchTokenRef.current) {
          setSwitchingHostId(null);
        }
      }
    }

    if (host.id !== LOCAL_HOST_ID && isTauriShell()) {
      setSwitchingHostId(host.id);
      const probe = await desktopHostProbe(origin).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      setStatusById((prev) => ({
        ...prev,
        [host.id]: { status: probe.status, latencyMs: probe.latencyMs },
      }));

      if (probe.status === 'unreachable') {
        toast.error(`Instance "${redactSensitiveUrl(host.label)}" is unreachable`);
        setSwitchingHostId(null);
        return;
      }
    }

    const target = toNavigationUrl(origin);
    onHostSwitched?.();

    try {
      window.location.assign(target);
    } catch {
      window.location.href = target;
    }
  }, [onHostSwitched, sshHostIds, sshStatusesById]);

  const beginEdit = React.useCallback((host: DesktopHost) => {
    setEditingId(host.id);
    setEditLabel(host.label);
    setEditUrl(host.url);
    setError('');
  }, []);

  const cancelEdit = React.useCallback(() => {
    setEditingId(null);
    setEditLabel('');
    setEditUrl('');
  }, []);

  const commitEdit = React.useCallback(async () => {
    if (!editingId) return;
    if (editingId === LOCAL_HOST_ID) {
      cancelEdit();
      return;
    }

    const url = normalizeHostUrl(editUrl);
    if (!url) {
      setError('Invalid URL (must be http/https)');
      return;
    }

    const label = (editLabel || redactSensitiveUrl(url)).trim();
    const nextHosts = configHosts.map((h) => (h.id === editingId ? { ...h, label, url } : h));
    await persist(nextHosts, defaultHostId);
    cancelEdit();
  }, [cancelEdit, configHosts, defaultHostId, editLabel, editUrl, editingId, persist]);

  const addHost = React.useCallback(async () => {
    const url = normalizeHostUrl(newUrl);
    if (!url) {
      setError('Invalid URL (must be http/https)');
      return;
    }
    const label = (newLabel || redactSensitiveUrl(url)).trim();
    const id = makeId();

    const nextHosts = [{ id, label, url }, ...configHosts];
    await persist(nextHosts, defaultHostId);
    setNewLabel('');
    setNewUrl('');
    if (embedded) {
      setIsAddFormOpen(false);
    }
  }, [configHosts, defaultHostId, embedded, newLabel, newUrl, persist]);

  const deleteHost = React.useCallback(async (id: string) => {
    if (id === LOCAL_HOST_ID) return;
    const nextHosts = configHosts.filter((h) => h.id !== id);
    const nextDefault = defaultHostId === id ? LOCAL_HOST_ID : defaultHostId;
    await persist(nextHosts, nextDefault);
  }, [configHosts, defaultHostId, persist]);

  const setDefault = React.useCallback(async (id: string) => {
    const next = id === LOCAL_HOST_ID ? LOCAL_HOST_ID : id;
    await persist(configHosts, next);
  }, [configHosts, persist]);

  const openInNewWindow = React.useCallback((host: DesktopHost) => {
    const origin = host.id === LOCAL_HOST_ID ? getLocalOrigin() : (normalizeHostUrl(host.url) || '');
    if (!origin) return;
    const target = toNavigationUrl(origin);
    desktopOpenNewWindowAtUrl(target).catch((err: unknown) => {
      toast.error('Failed to open new window', {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }, []);

  const switchToLocal = React.useCallback(() => {
    sshSwitchTokenRef.current += 1;
    setSwitchingHostId(null);
    setSshSwitchModal((prev) => ({
      ...prev,
      open: false,
      hostId: null,
      error: null,
      detail: null,
      phase: 'idle',
    }));
    const localTarget = toNavigationUrl(getLocalOrigin());
    onHostSwitched?.();
    window.location.assign(localTarget);
  }, [onHostSwitched]);

  const cancelSshSwitch = React.useCallback(async () => {
    const hostId = sshSwitchModal.hostId || switchingHostId;
    sshSwitchTokenRef.current += 1;
    setSwitchingHostId(null);
    setSshSwitchModal({
      open: false,
      hostId: null,
      hostLabel: '',
      phase: 'idle',
      detail: null,
      error: null,
    });

    if (!hostId || hostId === LOCAL_HOST_ID || !isTauriShell()) {
      return;
    }

    await desktopSshDisconnect(hostId).catch(() => {});
  }, [sshSwitchModal.hostId, switchingHostId]);

  const retrySshSwitch = React.useCallback(() => {
    const hostId = sshSwitchModal.hostId;
    if (!hostId) return;
    const host = allHosts.find((item) => item.id === hostId);
    if (!host) return;
    void handleSwitch(host);
  }, [allHosts, handleSwitch, sshSwitchModal.hostId]);

  const connectSshHostInPlace = React.useCallback(async (host: DesktopHost) => {
    if (!isTauriShell()) return;
    setSwitchingHostId(host.id);
    try {
      await desktopSshConnect(host.id);
      const readyStatus = await waitForSshReady(host.id, SSH_CONNECT_TIMEOUT_MS, (status) => {
        setSshStatusesById((prev) => ({
          ...prev,
          [status.id]: status,
        }));
      });
      if (readyStatus.phase === 'ready') {
        toast.success(`SSH instance "${redactSensitiveUrl(host.label)}" connected`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== SSH_CONNECT_CANCELLED_ERROR) {
        toast.error(`SSH instance "${redactSensitiveUrl(host.label)}" failed to connect`, {
          description: message,
        });
      }
    } finally {
      setSwitchingHostId(null);
    }
  }, []);

  if (!isDesktopShell()) {
    return null;
  }

  const tauriAvailable = isTauriShell();

  const content = (
    <>
      {embedded ? (
        <div className="flex-shrink-0 border-b border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-2">
              <span className="typography-ui-header font-semibold text-foreground">Current</span>
              <span className="max-w-[9rem] truncate typography-ui-label text-muted-foreground">{redactSensitiveUrl(current.label)}</span>
              <span className="text-muted-foreground">•</span>
              <span className="typography-ui-header font-semibold text-foreground">Default</span>
              <span className="max-w-[9rem] truncate typography-ui-label text-muted-foreground">{redactSensitiveUrl(currentDefaultLabel)}</span>
            </div>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                'hover:text-foreground hover:bg-interactive-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              onClick={() => void probeAll(allHosts)}
              disabled={!tauriAvailable || isLoading || isProbing}
              aria-label="Refresh instances"
            >
              <RiRefreshLine className={cn('h-4 w-4', isProbing && 'animate-spin')} />
            </button>
          </div>
        </div>
      ) : (
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RiServerLine className="h-5 w-5" />
            Instance
          </DialogTitle>
          <DialogDescription>
            Switch between Local and remote OpenChamber servers
          </DialogDescription>
        </DialogHeader>
      )}

      {!embedded && (
        <div className="flex items-center justify-between gap-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="typography-meta text-muted-foreground">Current:</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(current.label)}</span>
            <span className="typography-meta text-muted-foreground">Current default:</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(currentDefaultLabel)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void probeAll(allHosts)}
              disabled={!tauriAvailable || isLoading || isProbing}
            >
              <RiRefreshLine className={cn('h-4 w-4', isProbing && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
      )}

        {tauriAvailable && (
          <div className="flex-shrink-0 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="typography-micro text-muted-foreground">Need SSH instances? Manage them in Settings.</span>
              <Button type="button" variant="outline" size="sm" onClick={openRemoteInstancesSettings}>
                <RiSettings3Line className="h-4 w-4" />
                Remote SSH
              </Button>
            </div>
          </div>
        )}

        {!tauriAvailable && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="typography-meta text-muted-foreground">
              Instance switcher is limited on this page. Use Local to recover.
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-1">
            {isLoading ? (
              <div className="px-2 py-2 text-muted-foreground text-sm">Loading…</div>
            ) : (
              allHosts.map((host) => {
                const isLocal = host.id === LOCAL_HOST_ID;
                const isSsh = Boolean(sshHostIds[host.id]);
                const isActive = host.id === current.id;
                const isDefault = (defaultHostId || LOCAL_HOST_ID) === host.id;
                const status = statusById[host.id] || null;
                const sshStatus = sshStatusesById[host.id] || null;
                const statusKind = isSsh ? sshPhaseToHostStatus(sshStatus?.phase) : (status?.status ?? null);
                const isEditing = editingId === host.id;
                const effectiveUrl = isLocal ? getLocalOrigin() : (normalizeHostUrl(host.url) || host.url);
                const displayLabel = redactSensitiveUrl(host.label);
                const displayUrl = redactSensitiveUrl(effectiveUrl);

                return (
                  <div
                    key={host.id}
                    className={cn(
                      'group flex items-center gap-2 px-2.5 py-2 rounded-md overflow-hidden',
                      isEditing ? 'bg-interactive-hover/20' : 'hover:bg-interactive-hover/30'
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        'flex items-center gap-2 flex-1 min-w-0 text-left',
                        isEditing && 'pointer-events-none opacity-70'
                      )}
                      onClick={() => void handleSwitch(host)}
                      disabled={switchingHostId === host.id}
                      aria-label={`Switch to ${displayLabel}`}
                    >
                      <span className={cn('h-2 w-2 rounded-full flex-shrink-0', statusDotClass(statusKind))} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn('typography-ui-label truncate', isActive ? 'text-foreground' : 'text-foreground')}>
                            {displayLabel}
                          </span>
                          {isSsh && (
                            <span className="typography-micro px-1 rounded leading-none pb-px text-[var(--status-info)] bg-[var(--status-info)]/10">
                              SSH
                            </span>
                          )}
                          {isActive && (
                            <span className="typography-micro text-muted-foreground">Current</span>
                          )}
                          <span className="inline-flex items-center gap-1 typography-micro text-muted-foreground">
                            {statusIcon(statusKind)}
                            <span>
                              {isSsh ? sshPhaseLabel(sshStatus?.phase) : statusLabel(status?.status ?? null)}
                              {!isSsh && status?.status === 'ok' && typeof status.latencyMs === 'number' ? ` · ${Math.max(0, Math.round(status.latencyMs))}ms ping` : ''}
                            </span>
                          </span>
                        </div>
                        <div className="typography-micro text-muted-foreground truncate font-mono">
                          {displayUrl}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {!isLocal && !isSsh && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="h-8 w-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                              aria-label="Instance actions"
                              disabled={isSaving}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <RiMore2Line className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-fit min-w-28">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                beginEdit(host);
                              }}
                              disabled={isSaving}
                            >
                              <RiPencilLine className="h-4 w-4 mr-1" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                void deleteHost(host.id);
                              }}
                              className="text-destructive focus:text-destructive"
                              disabled={isSaving}
                            >
                              <RiDeleteBinLine className="h-4 w-4 mr-1" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}

                      {isLocal && (
                        <div
                          className="h-8 w-8 opacity-0 pointer-events-none"
                          aria-hidden="true"
                        />
                      )}

                      {isSsh && !isLocal && (
                        (sshStatus?.phase === 'idle' || !sshStatus?.phase) ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2.5"
                            disabled={switchingHostId === host.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void connectSshHostInPlace(host);
                            }}
                          >
                            {switchingHostId === host.id ? <RiLoader4Line className="h-3.5 w-3.5 animate-spin" /> : <RiPlug2Line className="h-3.5 w-3.5" />}
                            Connect
                          </Button>
                        ) : (
                          <div
                            className="h-8 w-8 opacity-0 pointer-events-none"
                            aria-hidden="true"
                          />
                        )
                      )}

                      <Tooltip delayDuration={700}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              'h-8 w-8 rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                              isDefault
                                ? 'text-primary hover:text-primary/80'
                                : 'text-muted-foreground/60 hover:text-primary/80',
                            )}
                            onClick={() => void setDefault(host.id)}
                            aria-label={isDefault ? 'Default instance' : 'Set as default'}
                            disabled={isSaving}
                          >
                            {isDefault ? <RiStarFill className="h-4 w-4" /> : <RiStarLine className="h-4 w-4" />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {isDefault ? 'Default' : 'Set as default'}
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip delayDuration={700}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                              className={cn(
                                'h-8 w-8 rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                                statusKind === 'unreachable'
                                  ? 'text-muted-foreground/30 cursor-not-allowed'
                                  : 'text-muted-foreground/60 hover:text-foreground',
                              )}
                            onClick={(e) => {
                              e.stopPropagation();
                              openInNewWindow(host);
                            }}
                            disabled={statusKind === 'unreachable'}
                            aria-label="Open in new window"
                          >
                            <RiWindowLine className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {statusKind === 'unreachable' ? 'Instance unreachable' : 'Open in new window'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {tauriAvailable && editingId && editingId !== LOCAL_HOST_ID && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="typography-ui-label font-medium text-foreground">Edit instance</div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={() => void commitEdit()} disabled={isSaving}>
                  {isSaving ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="Label"
                disabled={isSaving}
              />
              <Input
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                placeholder="https://host:port"
                disabled={isSaving}
              />
            </div>
          </div>
        )}

        {embedded && !isAddFormOpen ? (
          <div className="flex-shrink-0 border-t border-[var(--interactive-border)]">
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-2 text-left text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
              onClick={() => setIsAddFormOpen(true)}
              disabled={!tauriAvailable || isSaving}
            >
              <RiAddLine className="h-4 w-4" />
              <span className="typography-ui-label">Add instance</span>
            </button>
          </div>
        ) : (
          <div className={cn(
            'flex-shrink-0',
            embedded
              ? 'border-t border-[var(--interactive-border)] px-2 py-2'
              : 'rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-2.5'
          )}>
            <div className="flex items-center justify-between gap-2">
              <div className="typography-ui-label font-medium text-foreground">Add instance</div>
              <div className="flex items-center gap-2">
                {embedded && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsAddFormOpen(false)}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void addHost()}
                  disabled={!tauriAvailable || isSaving || !newUrl.trim()}
                >
                  {isSaving ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
                  Add
                </Button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label (optional)"
                disabled={!tauriAvailable || isSaving}
              />
              <Input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://host:port"
                disabled={!tauriAvailable || isSaving}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="flex-shrink-0 typography-meta text-status-error">{error}</div>
        )}
    </>
  );

  const sshSwitchDialog = (
    <Dialog
      open={sshSwitchModal.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && switchingHostId) {
          void cancelSshSwitch();
          return;
        }
        setSshSwitchModal((prev) => ({
          ...prev,
          open: nextOpen,
          ...(nextOpen ? {} : { hostId: null, error: null, detail: null, phase: 'idle' as const }),
        }));
      }}
    >
      <DialogContent className="w-[min(28rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RiLoader4Line className={cn('h-4 w-4', !sshSwitchModal.error && 'animate-spin')} />
            Connecting to {sshSwitchModal.hostLabel || 'SSH instance'}
          </DialogTitle>
          <DialogDescription>
            {sshSwitchModal.error
              ? sshSwitchModal.error
              : sshSwitchModal.detail || sshPhaseLabel(sshSwitchModal.phase)}
          </DialogDescription>
        </DialogHeader>
        {sshSwitchModal.error ? (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={switchToLocal}
            >
              Switch to Local
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={retrySshSwitch}
              disabled={!sshSwitchModal.hostId}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );

  if (embedded) {
    return (
      <>
        <div className="w-full max-h-[70vh] flex flex-col overflow-hidden gap-2">
          {content}
        </div>
        {sshSwitchDialog}
      </>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[min(42rem,calc(100vw-2rem))] max-w-none max-h-[70vh] flex flex-col overflow-hidden gap-3">
          {content}
        </DialogContent>
      </Dialog>
      {sshSwitchDialog}
    </>
  );
}

type DesktopHostSwitcherButtonProps = {
  headerIconButtonClass: string;
};

export function DesktopHostSwitcherButton({ headerIconButtonClass }: DesktopHostSwitcherButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState('Local');
  const [status, setStatus] = React.useState<HostProbeResult['status'] | null>(null);
  const attemptedDefaultSshConnectRef = React.useRef(false);
  const [startupSshModal, setStartupSshModal] = React.useState<{
    open: boolean;
    hostId: string | null;
    hostLabel: string;
    error: string | null;
    connecting: boolean;
  }>({
    open: false,
    hostId: null,
    hostLabel: '',
    error: null,
    connecting: false,
  });

  const connectDefaultSshInstance = React.useCallback(async (
    hostId: string,
    hostLabel: string,
    options?: { showProgress?: boolean },
  ): Promise<boolean> => {
    const showProgress = Boolean(options?.showProgress);
    if (showProgress) {
      setStartupSshModal({
        open: true,
        hostId,
        hostLabel,
        error: null,
        connecting: true,
      });
    }

    try {
      await desktopSshConnect(hostId);
      const ready = await waitForSshReady(hostId, 45_000, () => {});
      const localUrl = normalizeHostUrl(ready.localUrl || '');
      if (!localUrl) {
        throw new Error('Connected but missing forwarded URL');
      }
      window.location.assign(toNavigationUrl(localUrl));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStartupSshModal({
        open: true,
        hostId,
        hostLabel,
        error: message,
        connecting: false,
      });
      return false;
    }
  }, []);

  const switchStartupToLocal = React.useCallback(async () => {
    setStartupSshModal({
      open: false,
      hostId: null,
      hostLabel: '',
      error: null,
      connecting: false,
    });

    await desktopHostsGet()
      .then((cfg) => desktopHostsSet({ hosts: cfg.hosts, defaultHostId: LOCAL_HOST_ID }))
      .catch(() => undefined);

    window.location.assign(toNavigationUrl(getLocalOrigin()));
  }, []);

  const retryStartupSsh = React.useCallback(() => {
    const hostId = startupSshModal.hostId;
    if (!hostId) return;
    void connectDefaultSshInstance(hostId, startupSshModal.hostLabel || 'SSH instance', {
      showProgress: true,
    });
  }, [connectDefaultSshInstance, startupSshModal.hostId, startupSshModal.hostLabel]);

  React.useEffect(() => {
    if (!isTauriShell()) return;

    let cancelled = false;
    const run = async () => {
      try {
        const cfg = await desktopHostsGet();
        const local = buildLocalHost();
        const all = [local, ...(cfg.hosts || [])];
        const current = resolveCurrentHost(all);

        if (
          !attemptedDefaultSshConnectRef.current &&
          current.id === LOCAL_HOST_ID &&
          cfg.defaultHostId &&
          cfg.defaultHostId !== LOCAL_HOST_ID
        ) {
          const sshCfg = await desktopSshInstancesGet().catch(() => ({ instances: [] }));
          const defaultSsh = sshCfg.instances.find((instance) => instance.id === cfg.defaultHostId);
          if (defaultSsh) {
            attemptedDefaultSshConnectRef.current = true;
            const hostLabel = redactSensitiveUrl(
              defaultSsh.nickname?.trim() || defaultSsh.sshParsed?.destination || defaultSsh.id,
            );
            const connected = await connectDefaultSshInstance(cfg.defaultHostId, hostLabel);
            if (connected || cancelled) {
              return;
            }
          }
        }

        if (cancelled) return;
        setLabel(redactSensitiveUrl(current.label || 'Instance'));
        const normalized = normalizeHostUrl(current.url);
        if (!normalized) {
          setStatus(null);
          return;
        }
        const res = await desktopHostProbe(normalized).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        if (cancelled) return;
        setStatus(res.status);
      } catch {
        if (!cancelled) {
          setLabel('Instance');
          setStatus(null);
        }
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connectDefaultSshInstance]);

  if (!isDesktopShell()) {
    return null;
  }

  const isCurrentlyLocal = locationMatchesHost(window.location.href, getLocalOrigin());

  const fallbackLabel = typeof window !== 'undefined' && window.location.hostname
    ? window.location.hostname
    : 'Instance';

  const effectiveLabel = isCurrentlyLocal
    ? 'Local'
    : label === 'Local'
      ? fallbackLabel
      : label;
  const safeEffectiveLabel = redactSensitiveUrl(effectiveLabel);

  return (
    <>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Switch instance"
            data-oc-host-switcher
            className={cn(headerIconButtonClass, 'relative w-auto px-3')}
          >
            <RiServerLine className="h-5 w-5" />
            <span className="hidden sm:inline typography-ui-label font-medium text-muted-foreground truncate max-w-[11rem]">
              {safeEffectiveLabel}
            </span>
            <span
              className={cn(
                'pointer-events-none absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full',
                statusDotClass(status)
              )}
              aria-label="Instance status"
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Instance</p>
        </TooltipContent>
      </Tooltip>
      <DesktopHostSwitcherDialog open={open} onOpenChange={setOpen} />
      <Dialog
        open={startupSshModal.open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && startupSshModal.connecting) {
            return;
          }
          if (!nextOpen) {
            setStartupSshModal((prev) => ({
              ...prev,
              open: false,
              connecting: false,
            }));
            return;
          }
          setStartupSshModal((prev) => ({ ...prev, open: true }));
        }}
      >
        <DialogContent className="w-[min(30rem,calc(100vw-2rem))] max-w-none">
          <DialogHeader>
            <DialogTitle>Default SSH instance unavailable</DialogTitle>
            <DialogDescription>
              {startupSshModal.connecting
                ? `Connecting to ${startupSshModal.hostLabel || 'SSH instance'}...`
                : startupSshModal.error || 'Failed to connect the default SSH instance.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void switchStartupToLocal()}
              disabled={startupSshModal.connecting}
            >
              Switch to Local
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={retryStartupSsh}
              disabled={startupSshModal.connecting || !startupSshModal.hostId}
            >
              {startupSshModal.connecting ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
              Retry
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DesktopHostSwitcherInline() {
  const [open, setOpen] = React.useState(false);

  if (!isDesktopShell()) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-oc-host-switcher
        className="w-full justify-center"
        onClick={() => setOpen(true)}
      >
        <RiServerLine className="h-4 w-4" />
        Switch instance
      </Button>
      <DesktopHostSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
