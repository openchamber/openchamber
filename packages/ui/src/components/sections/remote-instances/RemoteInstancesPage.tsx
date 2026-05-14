import React from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RemoteClientRecord } from '@/lib/api/types';
import { buildClientConnectionPayload, encodeClientConnectionPayload, parseClientConnectionPayload } from '@/lib/connectionPayload';
import {
  desktopSshLogsClear,
  desktopSshLogs,
  type DesktopSshInstance,
  type DesktopSshPortForward,
  type DesktopSshPortForwardType,
} from '@/lib/desktopSsh';
import {
  desktopHostsGet,
  desktopHostsSet,
  normalizeHostUrl,
  redactSensitiveUrl,
  type DesktopHost,
} from '@/lib/desktopHosts';
import { isDesktopShell } from '@/lib/desktop';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

const randomPort = (): number => {
  return Math.floor(20000 + Math.random() * 30000);
};

const isPortInUseError = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('address already in use') || message.includes('eaddrinuse') || message.includes('port already in use');
};

const phaseLabelKey = (phase?: string): I18nKey => {
  switch (phase) {
    case 'config_resolved':
      return 'settings.remoteInstances.page.phase.resolvingConfiguration';
    case 'auth_check':
      return 'settings.remoteInstances.page.phase.checkingAuth';
    case 'master_connecting':
      return 'settings.remoteInstances.page.phase.establishingSsh';
    case 'remote_probe':
      return 'settings.remoteInstances.page.phase.probingRemote';
    case 'installing':
      return 'settings.remoteInstances.page.phase.installingOpenChamber';
    case 'updating':
      return 'settings.remoteInstances.page.phase.updatingOpenChamber';
    case 'server_detecting':
      return 'settings.remoteInstances.page.phase.detectingServer';
    case 'server_starting':
      return 'settings.remoteInstances.page.phase.startingServer';
    case 'forwarding':
      return 'settings.remoteInstances.page.phase.forwardingPorts';
    case 'ready':
      return 'settings.remoteInstances.sidebar.phase.ready';
    case 'degraded':
      return 'settings.remoteInstances.page.phase.reconnecting';
    case 'error':
      return 'settings.remoteInstances.sidebar.phase.error';
    default:
      return 'settings.remoteInstances.sidebar.phase.idle';
  }
};

const CONNECTING_PHASES = new Set<string>([
  'config_resolved',
  'auth_check',
  'master_connecting',
  'remote_probe',
  'installing',
  'updating',
  'server_detecting',
  'server_starting',
  'forwarding',
]);

const isConnectingPhase = (phase?: string): boolean => {
  return Boolean(phase && CONNECTING_PHASES.has(phase));
};

const phaseDotClass = (phase?: string): string => {
  if (phase === 'ready') {
    return 'bg-[var(--status-success)] animate-pulse';
  }
  if (phase === 'error') {
    return 'bg-[var(--status-error)] animate-pulse';
  }
  if (phase === 'degraded' || isConnectingPhase(phase)) {
    return 'bg-[var(--status-warning)] animate-pulse';
  }
  return 'bg-muted-foreground/40';
};

const buildForwardLabel = (forward: DesktopSshPortForward): string => {
  if (forward.type === 'dynamic') {
    return `${forward.localHost || '127.0.0.1'}:${forward.localPort || 0}`;
  }
  if (forward.type === 'remote') {
    return `${forward.remoteHost || '127.0.0.1'}:${forward.remotePort || 0} -> ${forward.localHost || '127.0.0.1'}:${forward.localPort || 0}`;
  }
  return `${forward.localHost || '127.0.0.1'}:${forward.localPort || 0} -> ${forward.remoteHost || '127.0.0.1'}:${forward.remotePort || 0}`;
};

const makeForward = (): DesktopSshPortForward => {
  return {
    id: `forward-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    enabled: true,
    type: 'local',
    localHost: '127.0.0.1',
    localPort: randomPort(),
    remoteHost: '127.0.0.1',
    remotePort: 80,
  };
};

const suggestConcreteHost = (pattern: string): string => {
  const value = pattern.trim().replace(/\*/g, 'host').replace(/\?/g, 'x');
  return value || 'user@host';
};

const HintLabel: React.FC<{ label: string; hint: React.ReactNode }> = ({ label, hint }) => {
  return (
    <span className="inline-flex items-center gap-1 typography-meta text-muted-foreground">
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
        </TooltipTrigger>
        <TooltipContent sideOffset={8} className="max-w-xs">
          <div className="typography-meta text-foreground">{hint}</div>
        </TooltipContent>
      </Tooltip>
    </span>
  );
};

const forwardTypeDescriptionKey = (type: DesktopSshPortForwardType): I18nKey => {
  switch (type) {
    case 'remote':
      return 'settings.remoteInstances.page.forwardTypeDescription.remote';
    case 'dynamic':
      return 'settings.remoteInstances.page.forwardTypeDescription.dynamic';
    default:
      return 'settings.remoteInstances.page.forwardTypeDescription.local';
  }
};

const formatEndpoint = (host: string | undefined, port: number | undefined): string => {
  const value = (host || '').trim();
  const normalizedHost = !value || value === '127.0.0.1' || value === '::1' ? 'localhost' : value;
  return `${normalizedHost}:${port || 0}`;
};

const toBrowserHost = (host: string | undefined): string => {
  const value = (host || '').trim();
  if (!value || value === '0.0.0.0' || value === '::') {
    return '127.0.0.1';
  }
  return value;
};

const formatLogLine = (line: string): string => {
  const match = line.match(/^\[(\d{10,})\]\s*(?:\[([A-Z]+)\]\s*)?(.*)$/);
  if (!match) {
    return line;
  }

  const millis = Number(match[1]);
  const iso = Number.isFinite(millis) ? new Date(millis).toISOString() : match[1];
  const level = (match[2] || 'INFO').toUpperCase();
  const message = match[3] || '';
  return `[${iso}] [${level}] ${message}`;
};

const navigateToUrl = (rawUrl: string): void => {
  const target = rawUrl.trim();
  if (!target) {
    return;
  }
  try {
    window.location.assign(target);
  } catch {
    window.location.href = target;
  }
};

const normalizeForSave = (instance: DesktopSshInstance): DesktopSshInstance => {
  const trimmedCommand = instance.sshCommand.trim();
  const nickname = instance.nickname?.trim();
  const forwards = instance.portForwards.map((forward) => ({
    ...forward,
    localHost: forward.localHost?.trim() || '127.0.0.1',
    localPort: typeof forward.localPort === 'number' ? Math.max(1, Math.min(65535, Math.round(forward.localPort))) : undefined,
    remoteHost: forward.remoteHost?.trim(),
    remotePort:
      typeof forward.remotePort === 'number'
        ? Math.max(1, Math.min(65535, Math.round(forward.remotePort)))
        : undefined,
  }));

  return {
    ...instance,
    sshCommand: trimmedCommand,
    ...(nickname ? { nickname } : { nickname: undefined }),
    connectionTimeoutSec: Math.max(5, Math.min(240, Math.round(instance.connectionTimeoutSec || 60))),
    localForward: {
      ...instance.localForward,
      bindHost:
        instance.localForward.bindHost === 'localhost' ||
        instance.localForward.bindHost === '0.0.0.0'
          ? instance.localForward.bindHost
          : '127.0.0.1',
      preferredLocalPort:
        typeof instance.localForward.preferredLocalPort === 'number'
          ? Math.max(1, Math.min(65535, Math.round(instance.localForward.preferredLocalPort)))
          : undefined,
    },
    remoteOpenchamber: {
      ...instance.remoteOpenchamber,
      preferredPort:
        typeof instance.remoteOpenchamber.preferredPort === 'number'
          ? Math.max(1, Math.min(65535, Math.round(instance.remoteOpenchamber.preferredPort)))
          : undefined,
    },
    portForwards: forwards,
  };
};

export const RemoteInstancesPage: React.FC = () => {
  const { t } = useI18n();
  const { clientAuth } = useRuntimeAPIs();
  const showInstanceManagement = isDesktopShell();
  const instances = useDesktopSshStore((state) => state.instances);
  const statusesById = useDesktopSshStore((state) => state.statusesById);
  const importCandidates = useDesktopSshStore((state) => state.importCandidates);
  const isLoading = useDesktopSshStore((state) => state.isLoading);
  const isImportsLoading = useDesktopSshStore((state) => state.isImportsLoading);
  const isSaving = useDesktopSshStore((state) => state.isSaving);
  const error = useDesktopSshStore((state) => state.error);
  const load = useDesktopSshStore((state) => state.load);
  const loadImports = useDesktopSshStore((state) => state.loadImports);
  const refreshStatuses = useDesktopSshStore((state) => state.refreshStatuses);
  const upsertInstance = useDesktopSshStore((state) => state.upsertInstance);
  const createFromCommand = useDesktopSshStore((state) => state.createFromCommand);
  const removeInstance = useDesktopSshStore((state) => state.removeInstance);
  const connect = useDesktopSshStore((state) => state.connect);
  const disconnect = useDesktopSshStore((state) => state.disconnect);
  const retry = useDesktopSshStore((state) => state.retry);

  const selectedId = useUIStore((state) => state.settingsRemoteInstancesSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsRemoteInstancesSelectedId);

  const selectedInstance = React.useMemo(() => {
    if (!selectedId) return null;
    return instances.find((instance) => instance.id === selectedId) || null;
  }, [instances, selectedId]);

  const [draft, setDraft] = React.useState<DesktopSshInstance | null>(null);
  const [logDialogOpen, setLogDialogOpen] = React.useState(false);
  const [logDialogLoading, setLogDialogLoading] = React.useState(false);
  const [logDialogError, setLogDialogError] = React.useState<string | null>(null);
  const [logDialogLines, setLogDialogLines] = React.useState<string[]>([]);
  const [patternHost, setPatternHost] = React.useState<string | null>(null);
  const [patternDestination, setPatternDestination] = React.useState('');
  const [patternCreating, setPatternCreating] = React.useState(false);
  const [expandedForwards, setExpandedForwards] = React.useState<Record<string, boolean>>({});
  const [isPrimaryActionPending, setIsPrimaryActionPending] = React.useState(false);
  const [isRetryPending, setIsRetryPending] = React.useState(false);
  const [clockMs, setClockMs] = React.useState(() => Date.now());
  const [directHosts, setDirectHosts] = React.useState<DesktopHost[]>([]);
  const [directDefaultHostId, setDirectDefaultHostId] = React.useState<string | null>('local');
  const [directLoading, setDirectLoading] = React.useState(false);
  const [directSaving, setDirectSaving] = React.useState(false);
  const [directLabel, setDirectLabel] = React.useState('');
  const [directUrl, setDirectUrl] = React.useState('');
  const [directToken, setDirectToken] = React.useState('');
  const [directConnectLink, setDirectConnectLink] = React.useState('');
  const [directError, setDirectError] = React.useState<string | null>(null);
  const [directAddDialogOpen, setDirectAddDialogOpen] = React.useState(false);
  const [directImportDialogOpen, setDirectImportDialogOpen] = React.useState(false);
  const [directEditingId, setDirectEditingId] = React.useState<string | null>(null);
  const [directEditLabel, setDirectEditLabel] = React.useState('');
  const [directEditUrl, setDirectEditUrl] = React.useState('');
  const [directEditToken, setDirectEditToken] = React.useState('');
  const [remoteClients, setRemoteClients] = React.useState<RemoteClientRecord[]>([]);
  const [remoteClientsLoading, setRemoteClientsLoading] = React.useState(false);
  const [remoteClientLabel, setRemoteClientLabel] = React.useState('');
  const [createdRemoteClientToken, setCreatedRemoteClientToken] = React.useState<string | null>(null);
  const [remoteClientError, setRemoteClientError] = React.useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = React.useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = React.useState<string | null>(null);
  const revokedClientCount = React.useMemo(() => remoteClients.filter((client) => Boolean(client.revokedAt)).length, [remoteClients]);
  const [sshAddDialogOpen, setSshAddDialogOpen] = React.useState(false);
  const [sshCommandDraft, setSshCommandDraft] = React.useState('ssh user@example.com');
  const [sshNameDraft, setSshNameDraft] = React.useState('');

  React.useEffect(() => {
    void load();
    void loadImports();
  }, [load, loadImports]);

  const loadDirectHosts = React.useCallback(async () => {
    setDirectLoading(true);
    setDirectError(null);
    try {
      const config = await desktopHostsGet();
      setDirectHosts(config.hosts || []);
      setDirectDefaultHostId(config.defaultHostId || 'local');
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadDirectHosts();
  }, [loadDirectHosts]);

  const persistDirectHosts = React.useCallback(async (hosts: DesktopHost[], defaultHostId: string | null = directDefaultHostId) => {
    setDirectSaving(true);
    setDirectError(null);
    try {
      await desktopHostsSet({ hosts, defaultHostId, initialHostChoiceCompleted: true });
      setDirectHosts(hosts);
      setDirectDefaultHostId(defaultHostId);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectSaving(false);
    }
  }, [directDefaultHostId]);

  const handleAddDirectHost = React.useCallback(async () => {
    const url = normalizeHostUrl(directUrl);
    if (!url) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const host: DesktopHost = {
      id,
      label: directLabel.trim() || redactSensitiveUrl(url),
      url,
      apiUrl: url,
      ...(directToken.trim() ? { clientToken: directToken.trim() } : {}),
    };
    await persistDirectHosts([host, ...directHosts], directDefaultHostId);
    setDirectLabel('');
    setDirectUrl('');
    setDirectToken('');
    setDirectAddDialogOpen(false);
  }, [directDefaultHostId, directHosts, directLabel, directToken, directUrl, persistDirectHosts, t]);

  const importDirectConnectLink = React.useCallback(async () => {
    const payload = parseClientConnectionPayload(directConnectLink);
    if (!payload) {
      setDirectError(t('settings.remoteInstances.direct.error.invalidConnectLink'));
      return;
    }
    const url = normalizeHostUrl(payload.serverUrl);
    if (!url) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const existing = directHosts.find((host) => normalizeHostUrl(host.apiUrl || host.url) === url);
    if (existing) {
      const nextHosts = directHosts.map((host) => host.id === existing.id
        ? { ...host, label: payload.label || host.label, url, apiUrl: url, clientToken: payload.token }
        : host);
      await persistDirectHosts(nextHosts, directDefaultHostId);
    } else {
      const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await persistDirectHosts([{ id, label: payload.label || redactSensitiveUrl(url), url, apiUrl: url, clientToken: payload.token }, ...directHosts], directDefaultHostId);
    }
    setDirectConnectLink('');
    setDirectError(null);
    setDirectImportDialogOpen(false);
  }, [directConnectLink, directDefaultHostId, directHosts, persistDirectHosts, t]);

  const handleRemoveDirectHost = React.useCallback(async (id: string) => {
    const nextHosts = directHosts.filter((host) => host.id !== id);
    const nextDefault = directDefaultHostId === id ? 'local' : directDefaultHostId;
    await persistDirectHosts(nextHosts, nextDefault);
    if (directEditingId === id) {
      setDirectEditingId(null);
    }
  }, [directDefaultHostId, directEditingId, directHosts, persistDirectHosts]);

  const beginEditDirectHost = React.useCallback((host: DesktopHost) => {
    setDirectEditingId(host.id);
    setDirectEditLabel(host.label);
    setDirectEditUrl(host.apiUrl || host.url);
    setDirectEditToken(host.clientToken || '');
    setDirectError(null);
  }, []);

  const saveDirectHostEdit = React.useCallback(async () => {
    if (!directEditingId) return;
    const url = normalizeHostUrl(directEditUrl);
    if (!url) {
      setDirectError(t('desktopHostSwitcher.error.invalidUrl'));
      return;
    }
    const nextHosts = directHosts.map((host) => host.id === directEditingId
      ? {
        ...host,
        label: directEditLabel.trim() || redactSensitiveUrl(url),
        url,
        apiUrl: url,
        clientToken: directEditToken.trim() || undefined,
      }
      : host);
    await persistDirectHosts(nextHosts, directDefaultHostId);
    setDirectEditingId(null);
  }, [directDefaultHostId, directEditLabel, directEditToken, directEditUrl, directEditingId, directHosts, persistDirectHosts, t]);

  const createSshInstanceFromDialog = React.useCallback(async () => {
    const command = sshCommandDraft.trim();
    if (!command) {
      toast.error(t('settings.remoteInstances.page.toast.sshCommandRequired'));
      return;
    }
    const id = `ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await createFromCommand(id, command, sshNameDraft.trim() || t('settings.remoteInstances.sidebar.newSshInstanceName'));
      setSelectedId(id);
      setSshAddDialogOpen(false);
      setSshCommandDraft('ssh user@example.com');
      setSshNameDraft('');
      toast.success(t('settings.remoteInstances.page.toast.instanceCreated'));
    } catch (error) {
      toast.error(t('settings.remoteInstances.sidebar.toast.createFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [createFromCommand, setSelectedId, sshCommandDraft, sshNameDraft, t]);

  const setDefaultDirectHost = React.useCallback(async (id: string) => {
    await persistDirectHosts(directHosts, id);
  }, [directHosts, persistDirectHosts]);

  const loadRemoteClients = React.useCallback(async () => {
    if (!clientAuth) return;
    setRemoteClientsLoading(true);
    setRemoteClientError(null);
    try {
      setRemoteClients(await clientAuth.listClients());
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteClientsLoading(false);
    }
  }, [clientAuth]);

  React.useEffect(() => {
    void loadRemoteClients();
  }, [loadRemoteClients]);

  const createRemoteClient = React.useCallback(async () => {
    if (!clientAuth) return;
    setRemoteClientError(null);
    try {
      const result = await clientAuth.createClient({ label: remoteClientLabel.trim() || undefined });
      setCreatedRemoteClientToken(result.token);
      setRemoteClientLabel('');
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients, remoteClientLabel]);

  const createPairingLink = React.useCallback(async () => {
    if (!clientAuth) return;
    setRemoteClientError(null);
    try {
      const serverUrl = normalizeHostUrl(getRuntimeApiBaseUrl()) || window.location.origin;
      const result = await clientAuth.createClient({ label: remoteClientLabel.trim() || 'Paired client' });
      const payload = buildClientConnectionPayload({ serverUrl, token: result.token, label: remoteClientLabel || 'OpenChamber' });
      const encoded = encodeClientConnectionPayload(payload);
      setCreatedRemoteClientToken(result.token);
      setPairingUrl(encoded);
      setPairingQrDataUrl(await QRCode.toDataURL(encoded, { width: 192, margin: 1 }));
      setRemoteClientLabel('');
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients, remoteClientLabel]);

  const revokeRemoteClient = React.useCallback(async (id: string) => {
    if (!clientAuth) return;
    setRemoteClientError(null);
    try {
      await clientAuth.revokeClient(id);
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  const purgeRevokedRemoteClients = React.useCallback(async () => {
    if (!clientAuth) return;
    setRemoteClientError(null);
    try {
      await clientAuth.purgeRevokedClients();
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  React.useEffect(() => {
    setDraft(selectedInstance);
  }, [selectedInstance]);

  React.useEffect(() => {
    if (!selectedId) {
      return;
    }
    const interval = window.setInterval(() => {
      // Skip polling when tab is hidden to reduce background work
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void refreshStatuses();
    }, 2_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshStatuses, selectedId]);

  React.useEffect(() => {
    // Use requestAnimationFrame for smoother clock updates without setInterval overhead
    let rafId: number | null = null;
    let lastTime = Date.now();
    
    const tick = () => {
      const now = Date.now();
      // Update only once per second
      if (now - lastTime >= 1_000) {
        setClockMs(now);
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    
    // Only run when visible
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(tick);
    }
    
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && rafId === null) {
        rafId = requestAnimationFrame(tick);
      } else if (document.visibilityState !== 'visible' && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    
    document.addEventListener('visibilitychange', onVisibility);
    
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  const status = selectedId ? statusesById[selectedId] : null;
  const statusPhase = status?.phase;
  const isReady = statusPhase === 'ready';
  const isReconnecting = statusPhase === 'degraded';
  const isConnecting = isConnectingPhase(statusPhase);
  const isBusy = isConnecting || isReconnecting;
  const canDisconnect = isReady || isBusy;
  const statusAgeMs = status ? Math.max(0, clockMs - status.updatedAtMs) : 0;
  const reconnectAppearsStuck = isReconnecting && statusAgeMs > 12_000;

  const hasChanges = React.useMemo(() => {
    if (!draft || !selectedInstance) return false;
    return JSON.stringify(draft) !== JSON.stringify(selectedInstance);
  }, [draft, selectedInstance]);

  const updateDraft = React.useCallback((updater: (current: DesktopSshInstance) => DesktopSshInstance) => {
    setDraft((current) => (current ? updater(current) : current));
  }, []);

  const handleSave = React.useCallback(async () => {
    if (!draft) return;
    const normalized = normalizeForSave(draft);

    if (!normalized.sshCommand.trim()) {
      toast.error(t('settings.remoteInstances.page.toast.sshCommandRequired'));
      return;
    }

    if (normalized.localForward.bindHost === '0.0.0.0') {
      const allow = window.confirm(
        t('settings.remoteInstances.page.confirm.bindAllInterfaces'),
      );
      if (!allow) {
        return;
      }
    }

    if (
      normalized.auth.sshPassword?.enabled &&
      normalized.auth.sshPassword.value?.trim() &&
      normalized.auth.sshPassword.store !== 'settings'
    ) {
      const store = window.confirm(t('settings.remoteInstances.page.confirm.storeSshPasswordPlaintext'));
      normalized.auth.sshPassword.store = store ? 'settings' : 'never';
      if (!store) {
        normalized.auth.sshPassword.value = undefined;
      }
    }

    if (
      normalized.auth.openchamberPassword?.enabled &&
      normalized.auth.openchamberPassword.value?.trim() &&
      normalized.auth.openchamberPassword.store !== 'settings'
    ) {
      const store = window.confirm(t('settings.remoteInstances.page.confirm.storeUiPasswordPlaintext'));
      normalized.auth.openchamberPassword.store = store ? 'settings' : 'never';
      if (!store) {
        normalized.auth.openchamberPassword.value = undefined;
      }
    }

    try {
      await upsertInstance(normalized);
      toast.success(t('settings.remoteInstances.page.toast.instanceSaved'));
    } catch (error) {
      toast.error(t('settings.remoteInstances.page.toast.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft, t, upsertInstance]);

  const createImportedInstance = React.useCallback(
    async (host: string, destination: string): Promise<boolean> => {
      const id = `ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        await createFromCommand(id, `ssh ${destination}`, host);
        setSelectedId(id);
        toast.success(t('settings.remoteInstances.page.toast.instanceCreated'));
        return true;
      } catch (error) {
        toast.error(t('settings.remoteInstances.sidebar.toast.createFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    [createFromCommand, setSelectedId, t],
  );

  const closePatternDialog = React.useCallback(() => {
    if (patternCreating) {
      return;
    }
    setPatternHost(null);
    setPatternDestination('');
  }, [patternCreating]);

  const handleImportCandidate = React.useCallback(
    (host: string, pattern: boolean) => {
      if (pattern) {
        setPatternHost(host);
        setPatternDestination(suggestConcreteHost(host));
        return;
      }
      void createImportedInstance(host, host);
    },
    [createImportedInstance],
  );

  const handlePatternCreate = React.useCallback(async () => {
    const host = patternHost;
    const destination = patternDestination.trim();
    if (!host) {
      return;
    }
    if (!destination) {
      toast.error(t('settings.remoteInstances.page.toast.destinationRequired'));
      return;
    }

    setPatternCreating(true);
    try {
      const created = await createImportedInstance(host, destination);
      if (created) {
        setPatternHost(null);
        setPatternDestination('');
      }
    } finally {
      setPatternCreating(false);
    }
  }, [createImportedInstance, patternDestination, patternHost, t]);

  const connectWithPortRecovery = React.useCallback(async () => {
    if (!selectedInstance) return;
    try {
      await connect(selectedInstance.id);
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
        ...selectedInstance,
        localForward: {
          ...selectedInstance.localForward,
          preferredLocalPort: randomPort(),
        },
      };

      await upsertInstance(nextInstance);
      await connect(nextInstance.id);
      toast.success(t('settings.remoteInstances.sidebar.toast.retriedWithRandomPort'));
    }
  }, [connect, selectedInstance, t, upsertInstance]);

  const readLogsForInstance = React.useCallback(async (id: string) => {
    const lines = await desktopSshLogs(id, 600);
    return lines.map((line) => formatLogLine(line));
  }, []);

  const handleOpenLogs = React.useCallback(async () => {
    if (!draft) return;
    setLogDialogOpen(true);
    setLogDialogLoading(true);
    setLogDialogError(null);
    try {
      const lines = await readLogsForInstance(draft.id);
      setLogDialogLines(lines);
    } catch (error) {
      setLogDialogLines([]);
      setLogDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setLogDialogLoading(false);
    }
  }, [draft, readLogsForInstance]);

  React.useEffect(() => {
    if (!logDialogOpen || !draft) {
      return;
    }

    let disposed = false;
    const run = async () => {
      try {
        const lines = await readLogsForInstance(draft.id);
        if (!disposed) {
          setLogDialogLines(lines);
          setLogDialogError(null);
        }
      } catch (error) {
        if (!disposed) {
          setLogDialogError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void run();
    const interval = window.setInterval(() => {
      // Skip polling when tab is hidden
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void run();
    }, 1_000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [draft, logDialogOpen, readLogsForInstance]);

  const logLinesText = React.useMemo(() => logDialogLines.join('\n'), [logDialogLines]);

  const handleCopyAllLogs = React.useCallback(() => {
    if (!logLinesText.trim()) {
      toast.error(t('settings.remoteInstances.page.toast.noLogsToCopy'));
      return;
    }
    void copyTextToClipboard(logLinesText).then((result) => {
      if (result.ok) {
        toast.success(t('settings.remoteInstances.page.toast.logsCopied'));
      }
    });
  }, [logLinesText, t]);

  const handleClearLogs = React.useCallback(async () => {
    if (!draft) {
      return;
    }
    try {
      await desktopSshLogsClear(draft.id);
      setLogDialogLines([]);
      toast.success(t('settings.remoteInstances.page.toast.logsCleared'));
    } catch (error) {
      toast.error(t('settings.remoteInstances.page.toast.clearLogsFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft, t]);

  const handleOpenCurrentInstance = React.useCallback(async () => {
    if (!status?.localUrl) {
      toast.error(t('settings.remoteInstances.page.toast.instanceUrlUnavailable'));
      return;
    }

    const target = status.localUrl.trim();
    if (!target) {
      toast.error(t('settings.remoteInstances.page.toast.instanceUrlUnavailable'));
      return;
    }

    navigateToUrl(target);
  }, [status?.localUrl, t]);

  const handlePrimaryConnectionAction = React.useCallback(() => {
    if (!draft) {
      return;
    }

    setIsPrimaryActionPending(true);
    const operation = canDisconnect ? disconnect(draft.id) : connectWithPortRecovery();
    void operation
      .catch((error) => {
        const key = canDisconnect
          ? (isReady
            ? 'settings.remoteInstances.page.toast.disconnectFailed'
            : 'settings.remoteInstances.page.toast.cancelConnectionFailed')
          : 'settings.remoteInstances.page.toast.connectFailed';
        toast.error(t(key), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        setIsPrimaryActionPending(false);
      });
  }, [canDisconnect, connectWithPortRecovery, disconnect, draft, isReady, t]);

  const handleRetryAction = React.useCallback(() => {
    if (!draft) {
      return;
    }

    if (isConnecting) {
      return;
    }

    setIsRetryPending(true);
    const operation = isReconnecting
      ? disconnect(draft.id).then(() => connectWithPortRecovery())
      : retry(draft.id);

    void operation
      .catch((error) => {
        toast.error(t('settings.remoteInstances.page.toast.retryFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        setIsRetryPending(false);
      });
  }, [connectWithPortRecovery, disconnect, draft, isConnecting, isReconnecting, retry, t]);

  const retryButtonLabel = isConnecting
    ? t('settings.remoteInstances.page.actions.connecting')
    : isReconnecting
      ? reconnectAppearsStuck
        ? t('settings.remoteInstances.page.actions.reconnectNow')
        : t('settings.remoteInstances.page.actions.reconnecting')
      : t('settings.remoteInstances.sidebar.actions.retry');

  const canRetry =
    !isPrimaryActionPending &&
    !isRetryPending &&
    (statusPhase === 'error' || statusPhase === 'idle' || !statusPhase || (isReconnecting && reconnectAppearsStuck)) &&
    !isConnecting;

  const primaryButtonLabel = isReady
    ? t('settings.remoteInstances.sidebar.actions.disconnect')
    : canDisconnect
      ? t('settings.remoteInstances.page.actions.cancel')
      : t('settings.remoteInstances.sidebar.actions.connect');

  if (!draft) {
    return (
      <SettingsPageLayout>
        {clientAuth ? (
          <div className="mb-8">
            <div className="mb-1 px-1 space-y-0.5">
              <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.clientAuth.title')}</h3>
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.description')}</p>
            </div>
            <section className="px-2 pb-2 pt-0 space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input className="h-8" value={remoteClientLabel} onChange={(event) => setRemoteClientLabel(event.target.value)} placeholder={t('settings.remoteInstances.clientAuth.field.labelPlaceholder')} />
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => void createRemoteClient()}>
                  {t('settings.remoteInstances.clientAuth.actions.create')}
                </Button>
                <Button type="button" size="xs" className="!font-normal" onClick={() => void createPairingLink()}>
                  {t('settings.remoteInstances.clientAuth.actions.pair')}
                </Button>
              </div>
              {pairingUrl ? (
                <div className="flex flex-col gap-3 rounded-md border border-[var(--interactive-border)] p-2 sm:flex-row">
                  {pairingQrDataUrl ? <img src={pairingQrDataUrl} alt={t('settings.remoteInstances.clientAuth.qrAlt')} className="size-48 self-start" /> : null}
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.pairingUrl')}</p>
                    <code className="block select-all break-all typography-code text-foreground">{pairingUrl}</code>
                    <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => void copyTextToClipboard(pairingUrl)}>
                      <Icon name="file-copy" className="h-3.5 w-3.5" />
                      {t('settings.common.actions.copyAll')}
                    </Button>
                  </div>
                </div>
              ) : null}
              {createdRemoteClientToken ? (
                <div className="space-y-1 rounded-md border border-[var(--interactive-border)] p-2">
                  <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.createdToken')}</p>
                  <code className="block select-all break-all typography-code text-foreground">{createdRemoteClientToken}</code>
                </div>
              ) : null}
              <div className="space-y-1">
                {revokedClientCount > 0 ? (
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void purgeRevokedRemoteClients()}>
                      {t('settings.remoteInstances.clientAuth.actions.clearRevoked')}
                    </Button>
                  </div>
                ) : null}
                {remoteClientsLoading ? (
                  <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.loading')}</p>
                ) : remoteClients.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.state.empty')}</p>
                ) : remoteClients.map((client) => (
                  <div key={client.id} className="flex items-center justify-between gap-3 py-1.5">
                    <div className="min-w-0">
                      <p className="typography-ui-label text-foreground truncate">{client.label}</p>
                      <p className="typography-micro text-muted-foreground truncate">{client.revokedAt ? t('settings.remoteInstances.clientAuth.state.revoked') : client.lastUsedAt ? t('settings.remoteInstances.clientAuth.lastUsed', { date: client.lastUsedAt }) : t('settings.remoteInstances.clientAuth.neverUsed')}</p>
                    </div>
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void revokeRemoteClient(client.id)} disabled={Boolean(client.revokedAt)}>
                      {t('settings.remoteInstances.clientAuth.actions.revoke')}
                    </Button>
                  </div>
                ))}
              </div>
              {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
            </section>
          </div>
        ) : null}

        {showInstanceManagement ? <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
          <div className="mb-1 px-1 space-y-0.5">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.direct.title')}</h3>
            <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.description')}</p>
          </div>
          <section className="px-2 pb-2 pt-0 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <p className="typography-meta text-muted-foreground/70">{t('settings.remoteInstances.direct.note')}</p>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(true)} disabled={directSaving}>
                  {t('settings.remoteInstances.direct.import.action')}
                </Button>
                <Button type="button" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(true)} disabled={directSaving}>
                  <Icon name="add" className="h-3.5 w-3.5" />
                  {t('settings.remoteInstances.direct.actions.add')}
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              {directLoading ? (
                <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.state.loading')}</p>
              ) : directHosts.length === 0 ? (
                <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.direct.state.empty')}</p>
              ) : directHosts.map((host) => (
                <div key={host.id} className="py-1.5">
                  <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(host.label)}</p>
                          {directDefaultHostId === host.id ? <span className="typography-micro text-muted-foreground">{t('desktopHostSwitcher.header.default')}</span> : null}
                        </div>
                        <p className="typography-micro text-muted-foreground font-mono truncate">{redactSensitiveUrl(host.apiUrl || host.url)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void setDefaultDirectHost(host.id)} disabled={directSaving || directDefaultHostId === host.id} aria-label={t('desktopHostSwitcher.actions.setAsDefaultAria')}>
                          {directDefaultHostId === host.id ? <Icon name="star-fill" className="h-3.5 w-3.5" /> : <Icon name="star" className="h-3.5 w-3.5" />}
                        </Button>
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => beginEditDirectHost(host)} disabled={directSaving}>
                          <Icon name="pencil" className="h-3.5 w-3.5" />
                          {t('desktopHostSwitcher.actions.edit')}
                        </Button>
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void handleRemoveDirectHost(host.id)} disabled={directSaving}>
                          <Icon name="delete-bin" className="h-3.5 w-3.5" />
                          {t('settings.common.actions.delete')}
                        </Button>
                      </div>
                  </div>
                </div>
              ))}
            </div>

            {directError ? <p className="typography-meta text-[var(--status-error)]">{directError}</p> : null}
          </section>
        </div> : null}

        {showInstanceManagement ? <Dialog open={directAddDialogOpen} onOpenChange={setDirectAddDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.remoteInstances.direct.actions.add')}</DialogTitle>
              <DialogDescription>{t('settings.remoteInstances.direct.description')}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void handleAddDirectHost(); }}>
              <Input className="h-8" value={directLabel} onChange={(event) => setDirectLabel(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.labelPlaceholder')} disabled={directSaving} />
              <Input className="h-8" value={directUrl} onChange={(event) => setDirectUrl(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.urlPlaceholder')} disabled={directSaving} autoFocus />
              <Input className="h-8" value={directToken} onChange={(event) => setDirectToken(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.tokenPlaceholder')} type="password" disabled={directSaving} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(false)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving || !directUrl.trim()}>{t('settings.remoteInstances.direct.actions.add')}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <Dialog open={Boolean(directEditingId)} onOpenChange={(open) => { if (!open) setDirectEditingId(null); }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('desktopHostSwitcher.actions.edit')}</DialogTitle>
              <DialogDescription>{t('settings.remoteInstances.direct.description')}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveDirectHostEdit(); }}>
              <Input className="h-8" value={directEditLabel} onChange={(event) => setDirectEditLabel(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.labelPlaceholder')} disabled={directSaving} />
              <Input className="h-8" value={directEditUrl} onChange={(event) => setDirectEditUrl(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.urlPlaceholder')} disabled={directSaving} autoFocus />
              <Input className="h-8" value={directEditToken} onChange={(event) => setDirectEditToken(event.target.value)} placeholder={t('settings.remoteInstances.direct.field.tokenPlaceholder')} type="password" disabled={directSaving} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectEditingId(null)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving}>{t('settings.common.actions.saveChanges')}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <Dialog open={directImportDialogOpen} onOpenChange={setDirectImportDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.remoteInstances.direct.import.action')}</DialogTitle>
              <DialogDescription>{t('settings.remoteInstances.direct.import.description')}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void importDirectConnectLink(); }}>
              <Input className="h-8" value={directConnectLink} onChange={(event) => setDirectConnectLink(event.target.value)} placeholder={t('settings.remoteInstances.direct.import.placeholder')} disabled={directSaving} autoFocus />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(false)} disabled={directSaving}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={directSaving || !directConnectLink.trim()}>{t('settings.remoteInstances.direct.import.action')}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
          <div className="mb-1 px-1 space-y-0.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.sidebar.title')}</h3>
                <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.sidebar.total', { count: instances.length })}</p>
              </div>
              <Button type="button" size="xs" className="!font-normal" onClick={() => setSshAddDialogOpen(true)}>
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.sidebar.actions.addSshInstance')}
              </Button>
            </div>
          </div>
          <section className="px-2 pb-2 pt-0 space-y-1">
            {isLoading ? (
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.import.loading')}</p>
            ) : instances.length === 0 ? (
              <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.import.noneFound')}</p>
            ) : instances.map((instance) => {
              const instanceStatus = statusesById[instance.id];
              const title = instance.nickname?.trim() || instance.sshParsed?.destination || instance.id;
              const phase = instanceStatus?.phase;
              const ready = phase === 'ready';
              return (
                <div key={instance.id} className="flex items-center justify-between gap-3 py-1.5">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${phaseDotClass(phase)}`} />
                      <p className="typography-ui-label text-foreground truncate">{title}</p>
                    </div>
                    <p className="typography-micro text-muted-foreground truncate">
                      {t(phaseLabelKey(phase))}{instanceStatus?.localUrl ? ` · ${instanceStatus.localUrl}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => {
                      const op = ready ? disconnect(instance.id) : connect(instance.id);
                      void op.catch((err) => toast.error(ready ? t('settings.remoteInstances.sidebar.toast.disconnectFailed') : t('settings.remoteInstances.sidebar.toast.connectFailed'), {
                        description: err instanceof Error ? err.message : String(err),
                      }));
                    }}>
                      {ready ? <Icon name="stop" className="h-3.5 w-3.5" /> : <Icon name="plug-2" className="h-3.5 w-3.5" />}
                      {ready ? t('settings.remoteInstances.sidebar.actions.disconnect') : t('settings.remoteInstances.sidebar.actions.connect')}
                    </Button>
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setSelectedId(instance.id)}>
                      <Icon name="pencil" className="h-3.5 w-3.5" />
                      {t('desktopHostSwitcher.actions.edit')}
                    </Button>
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => {
                      const ok = window.confirm(t('settings.remoteInstances.page.confirm.removeInstance'));
                      if (!ok) return;
                      void removeInstance(instance.id).catch((err) => toast.error(t('settings.remoteInstances.page.toast.removeInstanceFailed'), {
                        description: err instanceof Error ? err.message : String(err),
                      }));
                    }}>
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                      {t('settings.common.actions.delete')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </section>
        </div> : null}

        {showInstanceManagement ? <Dialog open={sshAddDialogOpen} onOpenChange={setSshAddDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.remoteInstances.sidebar.actions.addSshInstance')}</DialogTitle>
              <DialogDescription>{t('settings.remoteInstances.page.section.instanceDescription')}</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void createSshInstanceFromDialog(); }}>
              <Input className="h-8" value={sshNameDraft} onChange={(event) => setSshNameDraft(event.target.value)} placeholder={t('settings.remoteInstances.page.field.nicknamePlaceholder')} disabled={isSaving} />
              <Input className="h-8" value={sshCommandDraft} onChange={(event) => setSshCommandDraft(event.target.value)} placeholder={t('settings.remoteInstances.page.field.sshCommandPlaceholder')} disabled={isSaving} autoFocus />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setSshAddDialogOpen(false)} disabled={isSaving}>{t('settings.common.actions.cancel')}</Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={isSaving || !sshCommandDraft.trim()}>{t('settings.common.actions.create')}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog> : null}

        {showInstanceManagement ? <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
          <div className="mb-1 px-1 space-y-0.5">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.import.sectionTitle')}</h3>
          </div>
          <section className="px-2 pb-2 pt-0">
          {isImportsLoading ? (
            <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.import.loading')}</p>
          ) : importCandidates.length === 0 ? (
            <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.import.noneFound')}</p>
          ) : (
            <div>
              {importCandidates.map((candidate) => (
                <div key={`${candidate.source}:${candidate.host}`} className="flex items-center justify-between gap-3 border-b border-[var(--surface-subtle)] py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="typography-ui-label font-medium text-foreground truncate">
                      {candidate.host}
                      {candidate.pattern ? ` ${t('settings.remoteInstances.page.import.patternSuffix')}` : ''}
                    </div>
                    <div className="typography-meta text-muted-foreground truncate">{candidate.sshCommand}</div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    onClick={() => void handleImportCandidate(candidate.host, candidate.pattern)}
                  >
                    {t('settings.common.actions.import')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
        </div> : null}

        <Dialog
          open={Boolean(patternHost)}
          onOpenChange={(open) => {
            if (!open) {
              closePatternDialog();
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('settings.remoteInstances.page.patternDialog.title')}</DialogTitle>
              <DialogDescription>
                {patternHost ? t('settings.remoteInstances.page.patternDialog.descriptionWithHost', { host: patternHost }) : t('settings.remoteInstances.page.patternDialog.description')}
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                handlePatternCreate();
              }}
            >
              <Input
                value={patternDestination}
                onChange={(event) => setPatternDestination(event.target.value)}
                placeholder={t('settings.remoteInstances.page.patternDialog.destinationPlaceholder')}
                autoFocus
              />
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={closePatternDialog} disabled={patternCreating}>
                  {t('settings.common.actions.cancel')}
                </Button>
                <Button type="submit" size="xs" className="!font-normal" disabled={patternCreating}>
                  {t('settings.remoteInstances.page.actions.create')}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </SettingsPageLayout>
    );
  }

  const isManagedMode = draft.remoteOpenchamber.mode === 'managed';
  const instanceTitle = draft.nickname?.trim() || draft.sshParsed?.destination || draft.id;

  return (
    <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-auto">
      <div className="mb-6 px-1">
        <h2 className="typography-ui-header font-semibold text-foreground truncate">{instanceTitle}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 typography-meta text-muted-foreground">
          <span className={`h-2.5 w-2.5 rounded-full ${phaseDotClass(statusPhase)}`} />
          <span>{t(phaseLabelKey(statusPhase))}</span>
          {status?.localUrl ? <span className="font-mono text-foreground/80">{status.localUrl}</span> : null}
          {reconnectAppearsStuck ? <span>{t('settings.remoteInstances.page.status.reconnectStale')}</span> : null}
        </div>
      </div>

      <div className="mb-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.actions')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.actionsDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={canDisconnect ? 'outline' : 'default'}
              size="xs"
              className="!font-normal"
              onClick={handlePrimaryConnectionAction}
              disabled={isPrimaryActionPending || isRetryPending}
            >
              {canDisconnect ? <Icon name="stop" className="h-3.5 w-3.5" /> : <Icon name="plug-2" className="h-3.5 w-3.5" />}
              {primaryButtonLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={handleRetryAction}
              disabled={!canRetry}
            >
              <Icon name="refresh" className={`h-3.5 w-3.5 ${isConnecting || (isReconnecting && !reconnectAppearsStuck) ? 'animate-spin' : ''}`} />
              {retryButtonLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => {
                void handleOpenLogs();
              }}
            >
              <Icon name="terminal-window" className="h-3.5 w-3.5" />
              {t('settings.remoteInstances.page.actions.logs')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal text-[var(--status-error)] border-[var(--status-error)]/30 hover:text-[var(--status-error)]"
              onClick={() => {
                const ok = window.confirm(t('settings.remoteInstances.page.confirm.removeInstance'));
                if (!ok) return;
                void removeInstance(draft.id)
                  .then(() => {
                    setSelectedId(null);
                    toast.success(t('settings.remoteInstances.page.toast.instanceRemoved'));
                  })
                  .catch((err) => {
                    toast.error(t('settings.remoteInstances.page.toast.removeInstanceFailed'), {
                      description: err instanceof Error ? err.message : String(err),
                    });
                  });
              }}
            >
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
              {t('settings.remoteInstances.sidebar.actions.remove')}
            </Button>
          </div>
          {status?.localUrl ? (
            <div className="flex flex-wrap items-center gap-2 typography-meta text-muted-foreground">
              <span>{t('settings.remoteInstances.page.status.currentLocalUrl')}</span>
              <span className="font-mono text-foreground/90">{status.localUrl}</span>
            </div>
          ) : null}
        </section>
      </div>

      <div className="mb-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.instance')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.instanceDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.sshCommand')}</span>
            <Input
              className="h-7 md:max-w-xl"
              value={draft.sshCommand}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  sshCommand: event.target.value,
                }))
              }
              placeholder={t('settings.remoteInstances.page.field.sshCommandPlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.nickname')}</span>
            <Input
              className="h-7 md:max-w-sm"
              value={draft.nickname || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  nickname: event.target.value,
                }))
              }
              placeholder={t('settings.remoteInstances.page.field.nicknamePlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.connectionTimeoutSeconds')}</span>
            <NumberInput
              containerClassName="w-fit"
              min={5}
              max={240}
              step={1}
              className="w-16 tabular-nums"
              value={draft.connectionTimeoutSec}
              onValueChange={(next) => {
                updateDraft((current) => ({
                  ...current,
                  connectionTimeoutSec: Number.isFinite(next) ? next : current.connectionTimeoutSec,
                }));
              }}
            />
          </div>
        </section>
      </div>

      <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.remoteServer')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.remoteServerDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.mode')}
                  hint={t('settings.remoteInstances.page.field.modeHint')}
                />
            </div>
            <Select
              value={draft.remoteOpenchamber.mode}
              onValueChange={(value) =>
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    mode: value === 'external' ? 'external' : 'managed',
                  },
                }))
              }
            >
              <SelectTrigger className="h-7 w-fit min-w-[140px]">
                <SelectValue placeholder={t('settings.remoteInstances.page.field.modePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managed">{t('settings.remoteInstances.page.field.modeManaged')}</SelectItem>
                <SelectItem value="external">{t('settings.remoteInstances.page.field.modeExternal')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.preferredRemotePort')}
                  hint={t('settings.remoteInstances.page.field.preferredRemotePortHint')}
                />
            </div>
            <NumberInput
              containerClassName="w-fit"
              min={1}
              max={65535}
              step={1}
              className="w-20 tabular-nums"
              value={draft.remoteOpenchamber.preferredPort}
              onValueChange={(next) => {
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    preferredPort: Number.isFinite(next) && next > 0 ? next : undefined,
                  },
                }));
              }}
              onClear={() => {
                updateDraft((current) => ({
                  ...current,
                  remoteOpenchamber: {
                    ...current.remoteOpenchamber,
                    preferredPort: undefined,
                  },
                }));
              }}
              emptyLabel={t('settings.remoteInstances.page.field.auto')}
            />
          </div>

          {isManagedMode ? (
            <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
              <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.installMethod')}
                  hint={t('settings.remoteInstances.page.field.installMethodHint')}
                />
              </div>
              <Select
                value={draft.remoteOpenchamber.installMethod}
                onValueChange={(value) =>
                  updateDraft((current) => ({
                    ...current,
                    remoteOpenchamber: {
                      ...current.remoteOpenchamber,
                      installMethod:
                        value === 'npm' || value === 'download_release' || value === 'upload_bundle'
                          ? value
                          : 'bun',
                    },
                  }))
                }
              >
                <SelectTrigger className="h-7 w-fit min-w-[140px]">
                  <SelectValue placeholder={t('settings.remoteInstances.page.field.selectInstallMethodPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bun">bun</SelectItem>
                  <SelectItem value="npm">npm</SelectItem>
                  <SelectItem value="download_release">{t('settings.remoteInstances.page.field.installMethodDownloadRelease')}</SelectItem>
                  <SelectItem value="upload_bundle">{t('settings.remoteInstances.page.field.installMethodUploadBundle')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {isManagedMode ? (
            <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
              <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.keepServerRunning')}
                  hint={t('settings.remoteInstances.page.field.keepServerRunningHint')}
                />
              </div>
              <div className="flex w-full items-center gap-2 md:max-w-xs">
                <Switch
                  checked={draft.remoteOpenchamber.keepRunning}
                  onCheckedChange={(checked) =>
                    updateDraft((current) => ({
                      ...current,
                      remoteOpenchamber: {
                        ...current.remoteOpenchamber,
                        keepRunning: checked,
                      },
                    }))
                  }
                />
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.mainTunnel')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.mainTunnelDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.bindHost')}
                  hint={t('settings.remoteInstances.page.field.bindHostHint')}
                />
            </div>
            <Select
              value={draft.localForward.bindHost}
              onValueChange={(value) => {
                if (value === '0.0.0.0') {
                  const allow = window.confirm(
                    t('settings.remoteInstances.page.confirm.bindAllInterfaces'),
                  );
                  if (!allow) return;
                }
                updateDraft((current) => ({
                  ...current,
                  localForward: {
                    ...current.localForward,
                    bindHost: value === 'localhost' || value === '0.0.0.0' ? value : '127.0.0.1',
                  },
                }));
              }}
            >
              <SelectTrigger className="h-7 w-fit min-w-[140px]">
                <SelectValue placeholder={t('settings.remoteInstances.page.field.selectBindHostPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="127.0.0.1">127.0.0.1</SelectItem>
                <SelectItem value="localhost">localhost</SelectItem>
                <SelectItem value="0.0.0.0">0.0.0.0</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <div className="w-56 shrink-0">
                <HintLabel
                  label={t('settings.remoteInstances.page.field.preferredLocalPort')}
                  hint={t('settings.remoteInstances.page.field.preferredLocalPortHint')}
                />
            </div>
            <div className="flex w-full items-center gap-2 md:max-w-sm">
              <NumberInput
                containerClassName="w-fit"
                min={1}
                max={65535}
                step={1}
                className="w-20 tabular-nums"
                value={draft.localForward.preferredLocalPort}
                onValueChange={(next) => {
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: Number.isFinite(next) && next > 0 ? next : undefined,
                    },
                  }));
                }}
                onClear={() => {
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: undefined,
                    },
                  }));
                }}
                emptyLabel={t('settings.remoteInstances.page.field.auto')}
              />
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal h-7 w-7 px-0"
                title={t('settings.remoteInstances.page.actions.pickRandomPort')}
                onClick={() =>
                  updateDraft((current) => ({
                    ...current,
                    localForward: {
                      ...current.localForward,
                      preferredLocalPort: randomPort(),
                    },
                  }))
                }
              >
                <Icon name="shuffle" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </section>
      </div>

      <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.authentication')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.authenticationDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-3">
          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.sshPasswordOptional')}</span>
            <Input
              className="h-7 md:max-w-sm"
              type="password"
              value={draft.auth.sshPassword?.value || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  auth: {
                    ...current.auth,
                    sshPassword: {
                      enabled: event.target.value.trim().length > 0,
                      value: event.target.value,
                      store: current.auth.sshPassword?.store || 'never',
                    },
                  },
                }))
              }
              placeholder={t('settings.remoteInstances.page.field.sshPasswordPlaceholder')}
            />
          </div>

          <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
            <span className="typography-ui-label text-foreground w-56 shrink-0">{t('settings.remoteInstances.page.field.uiPasswordOptional')}</span>
            <Input
              className="h-7 md:max-w-sm"
              type="password"
              value={draft.auth.openchamberPassword?.value || ''}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  auth: {
                    ...current.auth,
                    openchamberPassword: {
                      enabled: event.target.value.trim().length > 0,
                      value: event.target.value,
                      store: current.auth.openchamberPassword?.store || 'never',
                    },
                  },
                }))
              }
              placeholder={t('settings.remoteInstances.page.field.uiPasswordPlaceholder')}
            />
          </div>
        </section>
      </div>

      <div className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
        <div className="mb-1 px-1 space-y-0.5">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.page.section.portForwards')}</h3>
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.section.portForwardsDescription')}</p>
        </div>
        <section className="px-2 pb-2 pt-0 space-y-2">
          {draft.portForwards.length === 0 ? (
            <p className="typography-micro text-muted-foreground/80">{t('settings.remoteInstances.page.empty.noExtraForwards')}</p>
          ) : null}

          {draft.portForwards.map((forward, index) => {
            const updateForward = (updater: (forward: DesktopSshPortForward) => DesktopSshPortForward) => {
              updateDraft((current) => ({
                ...current,
                portForwards: current.portForwards.map((item, itemIndex) =>
                  itemIndex === index ? updater(item) : item,
                ),
              }));
            };

            const localLabel = forward.type === 'remote' ? 'Local target' : 'Local listen';
            const localHint = forward.type === 'remote'
              ? 'Local host and port on your machine that receives traffic from remote -R listener.'
              : 'Local host and port where this forward listens on your machine.';
            const remoteLabel = forward.type === 'remote' ? 'Remote listen' : 'Remote target';
            const remoteHint = forward.type === 'remote'
              ? 'Remote host and port where SSH creates the -R listener.'
              : 'Remote host and port that receives traffic from local -L listener.';

            const localEndpoint = formatEndpoint(forward.localHost || 'localhost', forward.localPort);
            const remoteEndpoint = formatEndpoint(forward.remoteHost || 'localhost', forward.remotePort);
            const canOpenLocalEndpoint =
              forward.type === 'local' && typeof forward.localPort === 'number' && forward.localPort > 0;
            const localEndpointUrl = canOpenLocalEndpoint
              ? `http://${toBrowserHost(forward.localHost)}:${forward.localPort}`
              : '';

            const isForwardOpen = Boolean(expandedForwards[forward.id]);

            const typeLabel = forward.type === 'local' ? t('settings.remoteInstances.page.forwardType.local') : forward.type === 'remote' ? t('settings.remoteInstances.page.forwardType.remote') : t('settings.remoteInstances.page.forwardType.dynamic');

            return (
              <Collapsible
                key={forward.id}
                open={isForwardOpen}
                onOpenChange={(open) => {
                  setExpandedForwards((current) => ({
                    ...current,
                    [forward.id]: open,
                  }));
                }}
                className={`${index > 0 ? 'border-t border-[var(--surface-subtle)]' : ''} py-2`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <CollapsibleTrigger className="flex items-center gap-2 group">
                      <Icon name="arrow-down-s" className={`h-4 w-4 text-muted-foreground transition-transform ${isForwardOpen ? 'rotate-180' : ''}`} />
                      <span className="typography-ui-label text-foreground truncate">{buildForwardLabel(forward)}</span>
                      <span className="typography-micro text-muted-foreground/70 shrink-0">{typeLabel}</span>
                    </CollapsibleTrigger>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={forward.enabled} onCheckedChange={(checked) => updateForward((item) => ({ ...item, enabled: checked }))} aria-label={t('settings.remoteInstances.page.actions.enableForwardAria')} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="!font-normal h-6 w-6 px-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
                      onClick={() =>
                        updateDraft((current) => ({
                          ...current,
                          portForwards: current.portForwards.filter((item) => item.id !== forward.id),
                        }))
                      }
                    >
                      <Icon name="delete-bin" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <CollapsibleContent className="pt-2">
                  <div className="space-y-0 pb-2">
                    <p className="typography-meta text-muted-foreground mb-3">{t(forwardTypeDescriptionKey(forward.type))}</p>
                    <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                      <div className="w-56 shrink-0">
                        <HintLabel
                          label={t('settings.remoteInstances.page.field.forwardType')}
                          hint={t('settings.remoteInstances.page.field.forwardTypeHint')}
                        />
                      </div>
                      <Select
                        value={forward.type}
                        onValueChange={(value) =>
                          updateForward((item) => ({
                            ...item,
                            type: (value === 'dynamic' || value === 'remote' ? value : 'local') as DesktopSshPortForwardType,
                          }))
                        }
                      >
                        <SelectTrigger className="h-7 w-fit min-w-[140px]">
                          <SelectValue placeholder={t('settings.remoteInstances.page.field.typePlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="local">{t('settings.remoteInstances.page.forwardType.local')}</SelectItem>
                          <SelectItem value="remote">{t('settings.remoteInstances.page.forwardType.remote')}</SelectItem>
                          <SelectItem value="dynamic">{t('settings.remoteInstances.page.forwardType.dynamic')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                      <div className="w-56 shrink-0">
                        <HintLabel label={localLabel} hint={localHint} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-7 w-32"
                          value={forward.localHost || '127.0.0.1'}
                          onChange={(event) =>
                            updateForward((item) => ({
                              ...item,
                              localHost: event.target.value,
                            }))
                          }
                          placeholder={t('settings.remoteInstances.page.field.localHostPlaceholder')}
                        />
                        <span className="text-muted-foreground">:</span>
                        <NumberInput
                          containerClassName="w-fit"
                          min={1}
                          max={65535}
                          step={1}
                          className="w-16 tabular-nums"
                          value={forward.localPort}
                          onValueChange={(next) => {
                            updateForward((item) => ({
                              ...item,
                              localPort: Number.isFinite(next) && next > 0 ? next : undefined,
                            }));
                          }}
                          onClear={() => {
                            updateForward((item) => ({
                              ...item,
                              localPort: undefined,
                            }));
                          }}
                          emptyLabel={t('settings.remoteInstances.page.field.auto')}
                        />
                      </div>
                    </div>

                    {forward.type !== 'dynamic' ? (
                      <div className="flex flex-col gap-1.5 py-1.5 md:flex-row md:items-center md:gap-8">
                        <div className="w-56 shrink-0">
                          <HintLabel label={remoteLabel} hint={remoteHint} />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Input
                            className="h-7 w-32"
                            value={forward.remoteHost || ''}
                            onChange={(event) =>
                              updateForward((item) => ({
                                ...item,
                                remoteHost: event.target.value,
                              }))
                            }
                            placeholder={t('settings.remoteInstances.page.field.remoteHostPlaceholder')}
                          />
                          <span className="text-muted-foreground">:</span>
                          <NumberInput
                            containerClassName="w-fit"
                            min={1}
                            max={65535}
                            step={1}
                            className="w-16 tabular-nums"
                            value={forward.remotePort}
                            onValueChange={(next) => {
                              updateForward((item) => ({
                                ...item,
                                remotePort: Number.isFinite(next) && next > 0 ? next : undefined,
                              }));
                            }}
                            onClear={() => {
                              updateForward((item) => ({
                                ...item,
                                remotePort: undefined,
                              }));
                            }}
                            emptyLabel={t('settings.remoteInstances.page.field.auto')}
                          />
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--surface-subtle)] p-2">
                      <div className="flex flex-wrap items-center gap-1 typography-micro text-muted-foreground/80">
                        {forward.type === 'dynamic' ? (
                          <>
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.localSocks5')}</span>
                          </>
                        ) : forward.type === 'remote' ? (
                          <>
                            <Icon name="server" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{remoteEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.remote')}</span>
                            <Icon name="arrow-right" className="h-3.5 w-3.5" />
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.local')}</span>
                          </>
                        ) : (
                          <>
                            <Icon name="computer" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{localEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.local')}</span>
                            <Icon name="arrow-right" className="h-3.5 w-3.5" />
                            <Icon name="server" className="h-3.5 w-3.5" />
                            <span className="font-mono text-foreground">{remoteEndpoint}</span>
                            <span>{t('settings.remoteInstances.page.preview.remote')}</span>
                          </>
                        )}
                      </div>

                      {canOpenLocalEndpoint ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="!font-normal"
                          onClick={() => {
                            void openExternalUrl(localEndpointUrl).then((opened) => {
                              if (!opened) {
                                toast.error(t('settings.remoteInstances.page.toast.openLocalEndpointFailed'));
                              }
                            });
                          }}
                        >
                          <Icon name="external-link" className="h-3.5 w-3.5" />
                          {t('settings.remoteInstances.page.actions.openLocal')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}

          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal mt-1"
            onClick={() => {
              const nextForward = makeForward();
              updateDraft((current) => ({
                ...current,
                portForwards: [...current.portForwards, nextForward],
              }));
              setExpandedForwards((current) => ({
                ...current,
                [nextForward.id]: true,
              }));
            }}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
            {t('settings.remoteInstances.page.actions.addForward')}
          </Button>
        </section>
      </div>

      <div className="mt-8 border-t border-[var(--interactive-border)] pt-3">
        <div className="flex items-center gap-2">
          <Button type="button" size="xs" className="!font-normal" onClick={() => void handleSave()} disabled={!hasChanges || isSaving}>
            {t('settings.common.actions.saveChanges')}
          </Button>
          {status?.localUrl ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  void copyTextToClipboard(status.localUrl || '').then((result) => {
                    if (result.ok) {
                      toast.success(t('settings.remoteInstances.page.toast.localUrlCopied'));
                    }
                  });
                }}
              >
                <Icon name="file-copy" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.page.actions.copyLocalUrl')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  void handleOpenCurrentInstance();
                }}
              >
                <Icon name="external-link" className="h-3.5 w-3.5" />
                {t('settings.remoteInstances.page.actions.open')}
              </Button>
            </>
          ) : null}
          {error ? <div className="ml-auto typography-meta text-[var(--status-error)]">{error}</div> : null}
        </div>
      </div>

      <Dialog open={logDialogOpen} onOpenChange={setLogDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('settings.remoteInstances.page.logsDialog.title')}</DialogTitle>
            <DialogDescription>
              {draft?.nickname?.trim() || draft?.sshParsed?.destination || draft?.id || t('settings.remoteInstances.page.logsDialog.selectedInstanceFallback')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={handleCopyAllLogs} disabled={logDialogLoading || !logLinesText.trim()}>
              <Icon name="file-copy" className="h-3.5 w-3.5" />
              {t('settings.common.actions.copyAll')}
            </Button>
            <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => void handleClearLogs()} disabled={logDialogLoading}>
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
              {t('settings.common.actions.clear')}
            </Button>
          </div>
          {logDialogLoading ? (
            <div className="typography-meta text-muted-foreground">{t('settings.remoteInstances.page.logsDialog.loading')}</div>
          ) : logDialogError ? (
            <div className="typography-meta text-[var(--status-error)]">{logDialogError}</div>
          ) : (
            <pre className="max-h-[55vh] overflow-auto rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-3 typography-micro text-foreground whitespace-pre-wrap break-words">
              {logDialogLines.length > 0 ? logDialogLines.join('\n') : t('settings.remoteInstances.page.logsDialog.empty')}
            </pre>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(patternHost)}
        onOpenChange={(open) => {
          if (!open) {
            closePatternDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.remoteInstances.page.patternDialog.title')}</DialogTitle>
            <DialogDescription>
              {patternHost
                ? t('settings.remoteInstances.page.patternDialog.descriptionWithHost', { host: patternHost })
                : t('settings.remoteInstances.page.patternDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              handlePatternCreate();
            }}
          >
            <Input
              value={patternDestination}
              onChange={(event) => setPatternDestination(event.target.value)}
              placeholder={t('settings.remoteInstances.page.patternDialog.destinationPlaceholder')}
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={closePatternDialog} disabled={patternCreating}>
                {t('settings.common.actions.cancel')}
              </Button>
              <Button type="submit" size="xs" className="!font-normal" disabled={patternCreating}>
                {t('settings.common.actions.create')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      </DialogContent>
    </Dialog>
  );
};
