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
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { isElectronShell, isTauriShell, isDesktopShell } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopLocalClientTokenGet,
  desktopOpenNewWindowAtUrl,
  getDesktopHostApiUrl,
  locationMatchesHost,
  normalizeHostUrl,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
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

const runtimeKeyForHost = (host: DesktopHost): string => {
  if (host.id === LOCAL_HOST_ID) return 'local';
  return `host:${host.id}`;
};

type HostStatus = {
  status: HostProbeResult['status'];
  latencyMs: number;
};

type HostDisplayStatus = HostProbeResult['status'] | 'checking' | null;

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

const getLocalClientToken = async (): Promise<string> => {
  if (!isElectronShell()) return '';
  return desktopLocalClientTokenGet().catch(() => '');
};

const statusDotClass = (status: HostDisplayStatus): string => {
  if (status === 'ok') return 'bg-status-success';
  if (status === 'auth') return 'bg-status-warning';
  if (status === 'update-recommended') return 'bg-status-warning';
  if (status === 'incompatible') return 'bg-status-error';
  if (status === 'wrong-service') return 'bg-status-error';
  if (status === 'unreachable') return 'bg-status-error';
  if (status === 'checking') return 'bg-status-info';
  return 'bg-muted-foreground/40';
};

const isBlockedHostStatus = (status: HostProbeResult['status'] | null): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';
};

const isBlockedDisplayStatus = (status: HostDisplayStatus): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';
};

const statusLabelKey = (status: HostDisplayStatus):
  | 'desktopHostSwitcher.status.connected'
  | 'desktopHostSwitcher.status.authRequired'
  | 'desktopHostSwitcher.status.checking'
  | 'desktopHostSwitcher.status.updateRecommended'
  | 'desktopHostSwitcher.status.incompatible'
  | 'desktopHostSwitcher.status.wrongService'
  | 'desktopHostSwitcher.status.unreachable'
  | 'desktopHostSwitcher.status.unknown' => {
  if (status === 'ok') return 'desktopHostSwitcher.status.connected';
  if (status === 'auth') return 'desktopHostSwitcher.status.authRequired';
  if (status === 'checking') return 'desktopHostSwitcher.status.checking';
  if (status === 'update-recommended') return 'desktopHostSwitcher.status.updateRecommended';
  if (status === 'incompatible') return 'desktopHostSwitcher.status.incompatible';
  if (status === 'wrong-service') return 'desktopHostSwitcher.status.wrongService';
  if (status === 'unreachable') return 'desktopHostSwitcher.status.unreachable';
  return 'desktopHostSwitcher.status.unknown';
};

const statusIcon = (status: HostDisplayStatus) => {
  if (status === 'checking') return <Icon name="loader-4" className="h-4 w-4 animate-spin" />;
  if (status === 'ok') return <Icon name="check" className="h-4 w-4" />;
  if (status === 'auth') return <Icon name="shield-keyhole" className="h-4 w-4" />;
  if (status === 'update-recommended') return <Icon name="shield-keyhole" className="h-4 w-4" />;
  if (status === 'incompatible') return <Icon name="cloud-off" className="h-4 w-4" />;
  if (status === 'wrong-service') return <Icon name="cloud-off" className="h-4 w-4" />;
  if (status === 'unreachable') return <Icon name="cloud-off" className="h-4 w-4" />;
  return <Icon name="earth" className="h-4 w-4" />;
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const sshPhaseLabelKey = (phase: DesktopSshInstanceStatus['phase'] | undefined):
  | 'desktopHostSwitcher.sshPhase.ready'
  | 'desktopHostSwitcher.sshPhase.error'
  | 'desktopHostSwitcher.sshPhase.reconnecting'
  | 'desktopHostSwitcher.sshPhase.resolvingConfig'
  | 'desktopHostSwitcher.sshPhase.checkingAuth'
  | 'desktopHostSwitcher.sshPhase.connectingSsh'
  | 'desktopHostSwitcher.sshPhase.probingRemote'
  | 'desktopHostSwitcher.sshPhase.installing'
  | 'desktopHostSwitcher.sshPhase.updating'
  | 'desktopHostSwitcher.sshPhase.detectingServer'
  | 'desktopHostSwitcher.sshPhase.startingServer'
  | 'desktopHostSwitcher.sshPhase.forwardingPorts'
  | 'desktopHostSwitcher.sshPhase.idle' => {
  switch (phase) {
    case 'ready':
      return 'desktopHostSwitcher.sshPhase.ready';
    case 'error':
      return 'desktopHostSwitcher.sshPhase.error';
    case 'degraded':
      return 'desktopHostSwitcher.sshPhase.reconnecting';
    case 'config_resolved':
      return 'desktopHostSwitcher.sshPhase.resolvingConfig';
    case 'auth_check':
      return 'desktopHostSwitcher.sshPhase.checkingAuth';
    case 'master_connecting':
      return 'desktopHostSwitcher.sshPhase.connectingSsh';
    case 'remote_probe':
      return 'desktopHostSwitcher.sshPhase.probingRemote';
    case 'installing':
      return 'desktopHostSwitcher.sshPhase.installing';
    case 'updating':
      return 'desktopHostSwitcher.sshPhase.updating';
    case 'server_detecting':
      return 'desktopHostSwitcher.sshPhase.detectingServer';
    case 'server_starting':
      return 'desktopHostSwitcher.sshPhase.startingServer';
    case 'forwarding':
      return 'desktopHostSwitcher.sshPhase.forwardingPorts';
    default:
      return 'desktopHostSwitcher.sshPhase.idle';
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

const buildLocalHost = (localOrigin?: string | null): DesktopHost => ({
  id: LOCAL_HOST_ID,
  label: 'Local',
  url: localOrigin || getLocalOrigin(),
});

const resolveCurrentHost = (hosts: DesktopHost[]) => {
  const currentHref = typeof window === 'undefined' ? '' : window.location.href;
  const localOrigin = hosts.find((host) => host.id === LOCAL_HOST_ID)?.url || getLocalOrigin();
  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
  const normalizedLocal = normalizeHostUrl(localOrigin) || localOrigin;
  const normalizedCurrent = normalizeHostUrl(currentHref) || currentHref;

  if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const runtimeMatch = hosts.find((h) => {
    return runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(h)) : false;
  });

  if (runtimeMatch) {
    return {
      id: runtimeMatch.id,
      label: runtimeMatch.label,
      url: normalizeHostUrl(getDesktopHostApiUrl(runtimeMatch)) || getDesktopHostApiUrl(runtimeMatch),
    };
  }

  if (currentHref && locationMatchesHost(currentHref, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const match = hosts.find((h) => {
    return currentHref ? locationMatchesHost(currentHref, h.url) : false;
  });

  if (match) {
    return { id: match.id, label: match.label, url: normalizeHostUrl(match.url) || match.url };
  }

  if (currentHref.startsWith('openchamber-ui://')) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
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
  const { t } = useI18n();
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);

  const [configHosts, setConfigHosts] = React.useState<DesktopHost[]>([]);
  const [defaultHostId, setDefaultHostId] = React.useState<string | null>(null);
  const [statusById, setStatusById] = React.useState<Record<string, HostStatus>>({});
  const [probingHostIds, setProbingHostIds] = React.useState<Record<string, true>>({});
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
  const [localOrigin, setLocalOrigin] = React.useState<string>(() => getLocalOrigin());

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState('');
  const [editUrl, setEditUrl] = React.useState('');

  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const sshSwitchTokenRef = React.useRef(0);

  const allHosts = React.useMemo(() => {
    const local = buildLocalHost(localOrigin);
    const normalizedRemote = configHosts.map((h) => ({
      ...h,
      url: normalizeHostUrl(h.url) || h.url,
    }));
    return [local, ...normalizedRemote];
  }, [configHosts, localOrigin]);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged(() => setRuntimeEndpointEpoch((epoch) => epoch + 1));
  }, []);

  const current = React.useMemo(() => {
    void runtimeEndpointEpoch;
    return resolveCurrentHost(allHosts);
  }, [allHosts, runtimeEndpointEpoch]);
  const currentDefaultLabel = React.useMemo(() => {
    const id = defaultHostId || LOCAL_HOST_ID;
    return allHosts.find((h) => h.id === id)?.label || t('desktopHostSwitcher.instance.local');
  }, [allHosts, defaultHostId, t]);

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
      setError(err instanceof Error ? err.message : t('desktopHostSwitcher.error.failedToSave'));
    } finally {
      setIsSaving(false);
    }
  }, [t]);

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
      if (cfg.localOrigin) {
        setLocalOrigin(cfg.localOrigin);
      }
      const nextSshHostIds: Record<string, true> = {};
      for (const instance of sshCfg.instances) {
        nextSshHostIds[instance.id] = true;
      }
      setConfigHosts(cfg.hosts || []);
      setDefaultHostId(cfg.defaultHostId ?? null);
      setSshHostIds(nextSshHostIds);
      setSshStatusesById(sshStatusMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('desktopHostSwitcher.error.failedToLoad'));
      setConfigHosts([]);
      setDefaultHostId(null);
      setSshHostIds({});
      setSshStatusesById({});
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const probeAll = React.useCallback(async (hosts: DesktopHost[]) => {
    if (!isTauriShell()) return;
    setIsProbing(true);
    const nextProbingHostIds: Record<string, true> = {};
    for (const host of hosts) {
      nextProbingHostIds[host.id] = true;
    }
    setProbingHostIds(nextProbingHostIds);
    try {
      const localClientToken = await getLocalClientToken();
      const results = await Promise.all(
        hosts.map(async (h) => {
          const url = normalizeHostUrl(isElectronShell() ? getDesktopHostApiUrl(h) : h.url);
          if (!url) {
            return [h.id, { status: 'unreachable' as const, latencyMs: 0 } satisfies HostStatus] as const;
          }
          const clientToken = h.id === LOCAL_HOST_ID ? localClientToken : (h.clientToken || '');
          const res = await desktopHostProbe(url, { clientToken: clientToken || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
          return [h.id, { status: res.status, latencyMs: res.latencyMs } satisfies HostStatus] as const;
        })
      );
      const next: Record<string, HostStatus> = {};
      for (const [id, val] of results) {
        next[id] = val;
      }
      setStatusById(next);
    } finally {
      setProbingHostIds({});
      setIsProbing(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      setEditingId(null);
      setEditLabel('');
      setEditUrl('');
      setSwitchingHostId(null);
      setSshSwitchModal({ open: false, hostId: null, hostLabel: '', phase: 'idle', detail: null, error: null });
      setError('');
      return;
    }
    void refresh();
  }, [open, refresh]);

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
      // Skip polling when tab is hidden to reduce background work
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void run();
    }, 1_500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open]);

  const handleSwitch = React.useCallback(async (host: DesktopHost) => {
    const origin = host.id === LOCAL_HOST_ID ? localOrigin : (normalizeHostUrl(host.url) || '');
    const apiOrigin = host.id === LOCAL_HOST_ID ? localOrigin : (normalizeHostUrl(getDesktopHostApiUrl(host)) || '');
    if (!origin) return;

    if (isElectronShell()) {
      if (!apiOrigin) return;
      setSwitchingHostId(host.id);
      const clientToken = host.id === LOCAL_HOST_ID ? await getLocalClientToken() : (host.clientToken || '');
      const probe = await desktopHostProbe(apiOrigin, { clientToken: clientToken || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      setStatusById((prev) => ({
        ...prev,
        [host.id]: { status: probe.status, latencyMs: probe.latencyMs },
      }));

      if (isBlockedHostStatus(probe.status)) {
        toast.error(t('desktopHostSwitcher.toast.instanceUnreachable', { host: redactSensitiveUrl(host.label) }));
        setSwitchingHostId(null);
        return;
      }

      switchRuntimeEndpoint({ apiBaseUrl: apiOrigin, clientToken: clientToken || null, runtimeKey: runtimeKeyForHost(host) });
      onHostSwitched?.();
      setSwitchingHostId(null);
      return;
    }

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
        toast.error(t('desktopHostSwitcher.toast.sshFailedToConnect', { host: redactSensitiveUrl(host.label) }), {
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
      const probe = await desktopHostProbe(origin, { clientToken: host.clientToken || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      setStatusById((prev) => ({
        ...prev,
        [host.id]: { status: probe.status, latencyMs: probe.latencyMs },
      }));

      if (isBlockedHostStatus(probe.status)) {
        toast.error(t('desktopHostSwitcher.toast.instanceUnreachable', { host: redactSensitiveUrl(host.label) }));
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
  }, [localOrigin, onHostSwitched, sshHostIds, sshStatusesById, t]);

  const cancelEdit = React.useCallback(() => {
    setEditingId(null);
    setEditLabel('');
    setEditUrl('');
  }, []);

  const stopDropdownTypeahead = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  const commitEdit = React.useCallback(async () => {
    if (!editingId) return;
    if (editingId === LOCAL_HOST_ID) {
      cancelEdit();
      return;
    }

    const resolved = resolveDesktopHostUrl(editUrl);
    if (!resolved) {
      setError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const url = resolved.persistedUrl;

    const label = (editLabel || redactSensitiveUrl(url)).trim();
    const nextHosts = configHosts.map((h) => (h.id === editingId ? { ...h, label, url } : h));
    await persist(nextHosts, defaultHostId);
    cancelEdit();
    if (resolved.redeemUrl) {
      window.location.assign(resolved.redeemUrl);
    }
  }, [cancelEdit, configHosts, defaultHostId, editLabel, editUrl, editingId, persist, t]);

  const setDefault = React.useCallback(async (id: string) => {
    const next = id === LOCAL_HOST_ID ? LOCAL_HOST_ID : id;
    await persist(configHosts, next);
  }, [configHosts, persist]);

  const openInNewWindow = React.useCallback((host: DesktopHost) => {
    const origin = host.id === LOCAL_HOST_ID ? localOrigin : getDesktopHostApiUrl(host);
    if (!origin) return;
    const target = toNavigationUrl(origin);
    desktopOpenNewWindowAtUrl(target, { clientToken: host.clientToken || null }).catch((err: unknown) => {
      toast.error(t('desktopHostSwitcher.error.failedToOpenNewWindow'), {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }, [localOrigin, t]);

  const switchToLocal = React.useCallback(async () => {
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
    const localTarget = toNavigationUrl(localOrigin);
    if (isElectronShell()) {
      const clientToken = await getLocalClientToken();
      switchRuntimeEndpoint({ apiBaseUrl: localOrigin, clientToken: clientToken || null, runtimeKey: 'local' });
      onHostSwitched?.();
      return;
    }
    onHostSwitched?.();
    window.location.assign(localTarget);
  }, [localOrigin, onHostSwitched]);

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
        toast.success(t('desktopHostSwitcher.toast.sshConnected', { host: redactSensitiveUrl(host.label) }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== SSH_CONNECT_CANCELLED_ERROR) {
        toast.error(t('desktopHostSwitcher.toast.sshFailedToConnect', { host: redactSensitiveUrl(host.label) }), {
          description: message,
        });
      }
    } finally {
      setSwitchingHostId(null);
    }
  }, [t]);

  if (!isDesktopShell()) {
    return null;
  }

  const tauriAvailable = isTauriShell();

  const content = (
    <>
      {embedded ? (
        <div className="flex-shrink-0 border-b border-[var(--interactive-border)] px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-baseline gap-1.5 typography-ui-label">
              <span className="font-medium text-foreground">{t('desktopHostSwitcher.header.current')}</span>
              <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(current.label)}</span>
              <span className="text-muted-foreground/50">•</span>
              <span className="font-medium text-foreground">{t('desktopHostSwitcher.header.default')}</span>
              <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(currentDefaultLabel)}</span>
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
              aria-label={t('desktopHostSwitcher.actions.refreshInstancesAria')}
            >
              <Icon name="refresh" className={cn('h-4 w-4', isProbing && 'animate-spin')} />
            </button>
          </div>
        </div>
      ) : (
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Icon name="server" className="h-5 w-5" />
            {t('desktopHostSwitcher.title')}
          </DialogTitle>
          <DialogDescription>
            {t('desktopHostSwitcher.description')}
          </DialogDescription>
        </DialogHeader>
      )}

      {!embedded && (
        <div className="flex items-center justify-between gap-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="typography-meta text-muted-foreground">{t('desktopHostSwitcher.header.currentColon')}</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(current.label)}</span>
            <span className="typography-meta text-muted-foreground">{t('desktopHostSwitcher.header.currentDefaultColon')}</span>
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
              <Icon name="refresh" className={cn('h-4 w-4', isProbing && 'animate-spin')} />
              {t('desktopHostSwitcher.actions.refresh')}
            </Button>
          </div>
        </div>
      )}

        {!tauriAvailable && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="typography-meta text-muted-foreground">
              {t('desktopHostSwitcher.state.limitedOnPage')}
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-1">
            {isLoading ? (
              <div className="px-2 py-2 text-muted-foreground text-sm">{t('desktopHostSwitcher.state.loading')}</div>
            ) : (
              allHosts.map((host) => {
                const isLocal = host.id === LOCAL_HOST_ID;
                const isSsh = Boolean(sshHostIds[host.id]);
                const isActive = host.id === current.id;
                const isDefault = (defaultHostId || LOCAL_HOST_ID) === host.id;
                const status = statusById[host.id] || null;
                const sshStatus = sshStatusesById[host.id] || null;
                const isChecking = !isSsh && Boolean(probingHostIds[host.id]);
                const statusKind: HostDisplayStatus = isSsh ? sshPhaseToHostStatus(sshStatus?.phase) : (isChecking ? 'checking' : (status?.status ?? null));
                const isEditing = editingId === host.id;
                const effectiveUrl = isLocal ? localOrigin : (normalizeHostUrl(host.url) || host.url);
                const displayLabel = host.id === LOCAL_HOST_ID
                  ? t('desktopHostSwitcher.instance.local')
                  : redactSensitiveUrl(host.label);
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
                      aria-label={t('desktopHostSwitcher.actions.switchToAria', { instance: displayLabel })}
                    >
                      <span className={cn('h-2 w-2 rounded-full flex-shrink-0', statusDotClass(statusKind))} />
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex min-w-0 max-w-[45%] items-center gap-1.5">
                            <span className="typography-ui-label truncate text-foreground">
                              {displayLabel}
                            </span>
                            {isSsh && (
                              <span className="typography-micro flex-shrink-0 px-1 rounded leading-none pb-px text-[var(--status-info)] bg-[var(--status-info)]/10">
                                SSH
                              </span>
                            )}
                            {isActive && (
                              <span className="typography-micro flex-shrink-0 text-muted-foreground">{t('desktopHostSwitcher.header.current')}</span>
                            )}
                          </div>
                          <span className="inline-flex min-w-0 flex-1 items-center gap-1 typography-micro text-muted-foreground">
                            <span className="flex-shrink-0">{statusIcon(statusKind)}</span>
                            <span className="truncate">
                              {isSsh ? t(sshPhaseLabelKey(sshStatus?.phase)) : t(statusLabelKey(statusKind))}
                              {!isSsh && statusKind === 'ok' && typeof status?.latencyMs === 'number'
                                ? t('desktopHostSwitcher.status.ping', { ms: Math.max(0, Math.round(status.latencyMs)) })
                                : ''}
                            </span>
                          </span>
                        </div>
                        <div className="typography-micro text-muted-foreground truncate font-mono">
                          {displayUrl}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 flex-shrink-0">
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
                            {switchingHostId === host.id ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : <Icon name="plug-2" className="h-3.5 w-3.5" />}
                            {t('desktopHostSwitcher.actions.connect')}
                          </Button>
                        ) : (
                          <div
                            className="h-8 w-8 opacity-0 pointer-events-none"
                            aria-hidden="true"
                          />
                        )
                      )}

                      <Tooltip>
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
                            aria-label={isDefault ? t('desktopHostSwitcher.actions.defaultInstanceAria') : t('desktopHostSwitcher.actions.setAsDefaultAria')}
                            disabled={isSaving || (!isDefault && isBlockedDisplayStatus(statusKind))}
                          >
                            {isDefault ? <Icon name="star-fill" className="h-4 w-4" /> : <Icon name="star" className="h-4 w-4" />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {isDefault ? t('desktopHostSwitcher.header.default') : t('desktopHostSwitcher.actions.setAsDefault')}
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                              className={cn(
                                'h-8 w-8 rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                                isBlockedDisplayStatus(statusKind)
                                  ? 'text-muted-foreground/30 cursor-not-allowed'
                                  : 'text-muted-foreground/60 hover:text-foreground',
                              )}
                            onClick={(e) => {
                              e.stopPropagation();
                              openInNewWindow(host);
                            }}
                            disabled={isBlockedDisplayStatus(statusKind)}
                            aria-label={t('desktopHostSwitcher.actions.openInNewWindowAria')}
                          >
                            <Icon name="window" className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {isBlockedDisplayStatus(statusKind)
                            ? t('desktopHostSwitcher.state.instanceUnreachable')
                            : t('desktopHostSwitcher.actions.openInNewWindow')}
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
              <div className="typography-ui-label font-medium text-foreground">{t('desktopHostSwitcher.edit.title')}</div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
                  {t('desktopHostSwitcher.actions.cancel')}
                </Button>
                <Button type="button" size="sm" onClick={() => void commitEdit()} disabled={isSaving}>
                  {isSaving ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
                  {t('desktopHostSwitcher.actions.save')}
                </Button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                onKeyDown={stopDropdownTypeahead}
                placeholder={t('desktopHostSwitcher.field.labelPlaceholder')}
                disabled={isSaving}
              />
              <Input
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                onKeyDown={stopDropdownTypeahead}
                placeholder={t('desktopHostSwitcher.field.urlPlaceholder')}
                disabled={isSaving}
              />
            </div>
          </div>
        )}

        <div className="flex-shrink-0 border-t border-[var(--interactive-border)]">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 py-2 text-left text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
            onClick={openRemoteInstancesSettings}
          >
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label">{t('desktopHostSwitcher.actions.addInstance')}</span>
          </button>
        </div>

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
            <Icon name="loader-4" className={cn('h-4 w-4', !sshSwitchModal.error && 'animate-spin')} />
            {t('desktopHostSwitcher.ssh.connectingTo', { host: sshSwitchModal.hostLabel || t('desktopHostSwitcher.ssh.instanceFallback') })}
          </DialogTitle>
          <DialogDescription>
            {sshSwitchModal.error
              ? sshSwitchModal.error
              : sshSwitchModal.detail || t(sshPhaseLabelKey(sshSwitchModal.phase))}
          </DialogDescription>
        </DialogHeader>
        {sshSwitchModal.error ? (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void switchToLocal()}
            >
              {t('desktopHostSwitcher.actions.switchToLocal')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={retrySshSwitch}
              disabled={!sshSwitchModal.hostId}
            >
              {t('desktopHostSwitcher.actions.retry')}
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
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState('Local');
  const [status, setStatus] = React.useState<HostProbeResult['status'] | null>(null);
  const [localOrigin, setLocalOrigin] = React.useState<string>(() => getLocalOrigin());
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
      if (isElectronShell()) {
        switchRuntimeEndpoint({ apiBaseUrl: localUrl, clientToken: null, runtimeKey: `ssh:${hostId}` });
      } else {
        window.location.assign(toNavigationUrl(localUrl));
      }
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

    let nextLocalOrigin = localOrigin;
    await desktopHostsGet()
      .then((cfg) => {
        if (cfg.localOrigin) {
          nextLocalOrigin = cfg.localOrigin;
          setLocalOrigin(cfg.localOrigin);
        }
        return desktopHostsSet({ hosts: cfg.hosts, defaultHostId: LOCAL_HOST_ID });
      })
      .catch(() => undefined);

    if (isElectronShell()) {
      const clientToken = await getLocalClientToken();
      switchRuntimeEndpoint({ apiBaseUrl: nextLocalOrigin, clientToken: clientToken || null, runtimeKey: 'local' });
    } else {
      window.location.assign(toNavigationUrl(nextLocalOrigin));
    }
  }, [localOrigin]);

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
        const nextLocalOrigin = cfg.localOrigin || localOrigin;
        if (cfg.localOrigin && cfg.localOrigin !== localOrigin) {
          setLocalOrigin(cfg.localOrigin);
        }
        const local = buildLocalHost(nextLocalOrigin);
        const all = [local, ...(cfg.hosts || [])];
        const current = resolveCurrentHost(all);

        if (
          !isElectronShell() &&
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
        setLabel(redactSensitiveUrl(current.label || t('desktopHostSwitcher.instance.fallback')));
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
          setLabel(t('desktopHostSwitcher.instance.fallback'));
          setStatus(null);
        }
      }
    };

    void run();
    const interval = window.setInterval(() => {
      // Skip polling when tab is hidden to reduce background work
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void run();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connectDefaultSshInstance, localOrigin, t]);

  if (!isDesktopShell()) {
    return null;
  }

  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
  const isCurrentlyLocal = runtimeApiBaseUrl
    ? locationMatchesHost(runtimeApiBaseUrl, localOrigin)
    : locationMatchesHost(window.location.href, localOrigin);

  const fallbackLabel = typeof window !== 'undefined' && window.location.hostname
    ? window.location.hostname
    : t('desktopHostSwitcher.instance.fallback');

  const effectiveLabel = isCurrentlyLocal
      ? t('desktopHostSwitcher.instance.local')
      : label === 'Local'
        ? fallbackLabel
        : label;
  const safeEffectiveLabel = redactSensitiveUrl(effectiveLabel);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t('desktopHostSwitcher.actions.switchInstanceAria')}
            data-oc-host-switcher
            className={cn(headerIconButtonClass, 'relative w-auto px-3')}
          >
            <Icon name="server" className="h-5 w-5" />
            <span className="hidden sm:inline typography-ui-label font-medium text-muted-foreground truncate max-w-[11rem]">
              {safeEffectiveLabel}
            </span>
            <span
              className={cn(
                'pointer-events-none absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full',
                statusDotClass(status)
              )}
              aria-label={t('desktopHostSwitcher.statusAria')}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('desktopHostSwitcher.title')}</p>
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
            <DialogTitle>{t('desktopHostSwitcher.startup.title')}</DialogTitle>
            <DialogDescription>
              {startupSshModal.connecting
                ? t('desktopHostSwitcher.startup.connectingTo', { host: startupSshModal.hostLabel || t('desktopHostSwitcher.ssh.instanceFallback') })
                : startupSshModal.error || t('desktopHostSwitcher.startup.failed')}
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
              {t('desktopHostSwitcher.actions.switchToLocal')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={retryStartupSsh}
              disabled={startupSshModal.connecting || !startupSshModal.hostId}
            >
              {startupSshModal.connecting ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
              {t('desktopHostSwitcher.actions.retry')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DesktopHostSwitcherInline() {
  const [open, setOpen] = React.useState(false);
  const { t } = useI18n();

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
        <Icon name="server" className="h-4 w-4" />
        {t('desktopHostSwitcher.actions.switchInstance')}
      </Button>
      <DesktopHostSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
