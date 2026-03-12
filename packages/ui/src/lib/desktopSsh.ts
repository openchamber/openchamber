import { isTauriShell } from '@/lib/desktop';

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

type TauriGlobal = {
  core?: {
    invoke?: TauriInvoke;
  };
  event?: {
    listen?: (
      event: string,
      handler: (evt: { payload?: unknown }) => void,
    ) => Promise<() => void>;
  };
};

export type DesktopSshRemoteMode = 'managed' | 'external';
export type DesktopSshInstallMethod = 'npm' | 'bun' | 'download_release' | 'upload_bundle';
export type DesktopSshSecretStore = 'never' | 'settings';

export type DesktopSshStoredSecret = {
  enabled: boolean;
  value?: string;
  store: DesktopSshSecretStore;
};

export type DesktopSshPortForwardType = 'local' | 'remote' | 'dynamic';

export type DesktopSshPortForward = {
  id: string;
  enabled: boolean;
  type: DesktopSshPortForwardType;
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
};

export type DesktopSshInstance = {
  id: string;
  nickname?: string;
  sshCommand: string;
  sshParsed?: {
    destination: string;
    args: string[];
  };
  connectionTimeoutSec: number;
  remoteOpenchamber: {
    mode: DesktopSshRemoteMode;
    keepRunning: boolean;
    preferredPort?: number;
    installMethod: DesktopSshInstallMethod;
    uploadBundleOverSsh: boolean;
  };
  localForward: {
    preferredLocalPort?: number;
    bindHost: '127.0.0.1' | 'localhost' | '0.0.0.0';
  };
  auth: {
    sshPassword?: DesktopSshStoredSecret;
    openchamberPassword?: DesktopSshStoredSecret;
  };
  portForwards: DesktopSshPortForward[];
};

export type DesktopSshInstancesConfig = {
  instances: DesktopSshInstance[];
};

export type DesktopSshPhase =
  | 'idle'
  | 'config_resolved'
  | 'auth_check'
  | 'master_connecting'
  | 'remote_probe'
  | 'installing'
  | 'updating'
  | 'server_detecting'
  | 'server_starting'
  | 'forwarding'
  | 'ready'
  | 'degraded'
  | 'error';

export type DesktopSshInstanceStatus = {
  id: string;
  phase: DesktopSshPhase;
  detail?: string;
  localUrl?: string;
  localPort?: number;
  remotePort?: number;
  startedByUs: boolean;
  retryAttempt: number;
  requiresUserAction: boolean;
  updatedAtMs: number;
};

export type DesktopSshImportCandidate = {
  host: string;
  pattern: boolean;
  source: string;
  sshCommand: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const readString = (obj: Record<string, unknown>, key: string): string | null => {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
};

const readNumber = (obj: Record<string, unknown>, key: string): number | null => {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const readBoolean = (obj: Record<string, unknown>, key: string): boolean | null => {
  const value = obj[key];
  return typeof value === 'boolean' ? value : null;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

const getInvoke = (): TauriInvoke | null => {
  if (!isTauriShell()) return null;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function' ? tauri.core.invoke : null;
};

const parseStoredSecret = (value: unknown): DesktopSshStoredSecret | undefined => {
  if (!isRecord(value)) return undefined;
  const enabled = readBoolean(value, 'enabled') ?? false;
  const rawStore = readString(value, 'store')?.toLowerCase();
  const store: DesktopSshSecretStore = rawStore === 'settings' ? 'settings' : 'never';
  const rawValue = readString(value, 'value');
  return {
    enabled,
    store,
    ...(rawValue ? { value: rawValue } : {}),
  };
};

const parseForwardType = (value: unknown): DesktopSshPortForwardType => {
  return value === 'remote' || value === 'dynamic' ? value : 'local';
};

const parseForward = (value: unknown): DesktopSshPortForward | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  if (!id) return null;
  const enabled = readBoolean(value, 'enabled') ?? true;
  const type = parseForwardType(readString(value, 'type'));
  const localHost = readString(value, 'localHost') || readString(value, 'local_host') || undefined;
  const localPort = readNumber(value, 'localPort') ?? readNumber(value, 'local_port') ?? undefined;
  const remoteHost = readString(value, 'remoteHost') || readString(value, 'remote_host') || undefined;
  const remotePort = readNumber(value, 'remotePort') ?? readNumber(value, 'remote_port') ?? undefined;
  return {
    id,
    enabled,
    type,
    ...(localHost ? { localHost } : {}),
    ...(typeof localPort === 'number' ? { localPort } : {}),
    ...(remoteHost ? { remoteHost } : {}),
    ...(typeof remotePort === 'number' ? { remotePort } : {}),
  };
};

const parseInstance = (value: unknown): DesktopSshInstance | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const sshCommand = readString(value, 'sshCommand') || readString(value, 'ssh_command');
  if (!id || !sshCommand) return null;
  const nickname = readString(value, 'nickname');

  const parsedRaw = value.sshParsed;
  const parsed = isRecord(parsedRaw)
    ? {
        destination: readString(parsedRaw, 'destination') || '',
        args: asStringArray(parsedRaw.args),
      }
    : undefined;

  const remoteRaw = isRecord(value.remoteOpenchamber)
    ? value.remoteOpenchamber
    : isRecord(value.remote_openchamber)
      ? value.remote_openchamber
      : {};

  const localRaw = isRecord(value.localForward)
    ? value.localForward
    : isRecord(value.local_forward)
      ? value.local_forward
      : {};

  const authRaw = isRecord(value.auth) ? value.auth : {};

  const rawMode = readString(remoteRaw, 'mode')?.toLowerCase();
  const mode: DesktopSshRemoteMode = rawMode === 'external' ? 'external' : 'managed';

  const rawInstallMethod = readString(remoteRaw, 'installMethod') || readString(remoteRaw, 'install_method');
  const installMethod: DesktopSshInstallMethod =
    rawInstallMethod === 'npm' ||
    rawInstallMethod === 'download_release' ||
    rawInstallMethod === 'upload_bundle'
      ? rawInstallMethod
      : 'bun';

  const bindHostRaw =
    readString(localRaw, 'bindHost') ||
    readString(localRaw, 'bind_host') ||
    '127.0.0.1';
  const bindHost: '127.0.0.1' | 'localhost' | '0.0.0.0' =
    bindHostRaw === 'localhost' || bindHostRaw === '0.0.0.0' ? bindHostRaw : '127.0.0.1';

  const forwardsRaw = Array.isArray(value.portForwards)
    ? value.portForwards
    : Array.isArray(value.port_forwards)
      ? value.port_forwards
      : [];

  const portForwards = forwardsRaw
    .map((item) => parseForward(item))
    .filter((item): item is DesktopSshPortForward => Boolean(item));

  const preferredPort = readNumber(remoteRaw, 'preferredPort') ?? readNumber(remoteRaw, 'preferred_port');
  const preferredLocalPort =
    readNumber(localRaw, 'preferredLocalPort') ?? readNumber(localRaw, 'preferred_local_port');
  const sshPassword = parseStoredSecret(authRaw.sshPassword || authRaw.ssh_password);
  const openchamberPassword = parseStoredSecret(authRaw.openchamberPassword || authRaw.openchamber_password);

  return {
    id,
    ...(nickname ? { nickname } : {}),
    sshCommand,
    ...(parsed && parsed.destination ? { sshParsed: parsed } : {}),
    connectionTimeoutSec:
      readNumber(value, 'connectionTimeoutSec') ??
      readNumber(value, 'connection_timeout_sec') ??
      60,
    remoteOpenchamber: {
      mode,
      keepRunning: readBoolean(remoteRaw, 'keepRunning') ?? readBoolean(remoteRaw, 'keep_running') ?? true,
      ...(preferredPort ? { preferredPort } : {}),
      installMethod,
      uploadBundleOverSsh:
        readBoolean(remoteRaw, 'uploadBundleOverSsh') ??
        readBoolean(remoteRaw, 'upload_bundle_over_ssh') ??
        false,
    },
    localForward: {
      ...(preferredLocalPort ? { preferredLocalPort } : {}),
      bindHost,
    },
    auth: {
      ...(sshPassword ? { sshPassword } : {}),
      ...(openchamberPassword ? { openchamberPassword } : {}),
    },
    portForwards,
  };
};

const parsePhase = (value: unknown): DesktopSshPhase => {
  switch (value) {
    case 'config_resolved':
    case 'auth_check':
    case 'master_connecting':
    case 'remote_probe':
    case 'installing':
    case 'updating':
    case 'server_detecting':
    case 'server_starting':
    case 'forwarding':
    case 'ready':
    case 'degraded':
    case 'error':
      return value;
    default:
      return 'idle';
  }
};

const parseStatus = (value: unknown): DesktopSshInstanceStatus | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  if (!id) return null;
  return {
    id,
    phase: parsePhase(readString(value, 'phase')),
    ...(readString(value, 'detail') ? { detail: readString(value, 'detail') || undefined } : {}),
    ...(readString(value, 'localUrl') || readString(value, 'local_url')
      ? { localUrl: readString(value, 'localUrl') || readString(value, 'local_url') || undefined }
      : {}),
    ...(typeof (readNumber(value, 'localPort') ?? readNumber(value, 'local_port')) === 'number'
      ? { localPort: readNumber(value, 'localPort') ?? readNumber(value, 'local_port') ?? undefined }
      : {}),
    ...(typeof (readNumber(value, 'remotePort') ?? readNumber(value, 'remote_port')) === 'number'
      ? {
          remotePort: readNumber(value, 'remotePort') ?? readNumber(value, 'remote_port') ?? undefined,
        }
      : {}),
    startedByUs: readBoolean(value, 'startedByUs') ?? readBoolean(value, 'started_by_us') ?? false,
    retryAttempt: readNumber(value, 'retryAttempt') ?? readNumber(value, 'retry_attempt') ?? 0,
    requiresUserAction:
      readBoolean(value, 'requiresUserAction') ?? readBoolean(value, 'requires_user_action') ?? false,
    updatedAtMs: readNumber(value, 'updatedAtMs') ?? readNumber(value, 'updated_at_ms') ?? Date.now(),
  };
};

const parseImportCandidate = (value: unknown): DesktopSshImportCandidate | null => {
  if (!isRecord(value)) return null;
  const host = readString(value, 'host');
  const source = readString(value, 'source');
  const sshCommand = readString(value, 'sshCommand') || readString(value, 'ssh_command');
  if (!host || !source || !sshCommand) return null;
  return {
    host,
    source,
    sshCommand,
    pattern: readBoolean(value, 'pattern') ?? false,
  };
};

export const createDesktopSshInstance = (id: string, sshCommand: string): DesktopSshInstance => {
  return {
    id,
    sshCommand,
    connectionTimeoutSec: 60,
    remoteOpenchamber: {
      mode: 'managed',
      keepRunning: true,
      installMethod: 'bun',
      uploadBundleOverSsh: false,
    },
    localForward: {
      bindHost: '127.0.0.1',
    },
    auth: {},
    portForwards: [],
  };
};

export const desktopSshInstancesGet = async (): Promise<DesktopSshInstancesConfig> => {
  const invoke = getInvoke();
  if (!invoke) {
    return { instances: [] };
  }

  const raw = await invoke('desktop_ssh_instances_get');
  if (!isRecord(raw)) {
    return { instances: [] };
  }

  const listRaw = Array.isArray(raw.instances)
    ? raw.instances
    : Array.isArray(raw.desktopSshInstances)
      ? raw.desktopSshInstances
      : [];

  const instances = listRaw
    .map((item) => parseInstance(item))
    .filter((item): item is DesktopSshInstance => Boolean(item));

  return { instances };
};

export const desktopSshInstancesSet = async (config: DesktopSshInstancesConfig): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_instances_set', {
    config: {
      instances: config.instances,
    },
  });
};

export const desktopSshImportHosts = async (): Promise<DesktopSshImportCandidate[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const raw = await invoke('desktop_ssh_import_hosts');
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseImportCandidate(item))
    .filter((item): item is DesktopSshImportCandidate => Boolean(item));
};

export const desktopSshConnect = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_connect', { id });
};

export const desktopSshDisconnect = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_disconnect', { id });
};

export const desktopSshStatus = async (id?: string): Promise<DesktopSshInstanceStatus[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const raw = await invoke('desktop_ssh_status', {
    ...(id ? { id } : {}),
  });
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseStatus(item))
    .filter((item): item is DesktopSshInstanceStatus => Boolean(item));
};

export const desktopSshLogs = async (id: string, limit?: number): Promise<string[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const raw = await invoke('desktop_ssh_logs', {
    id,
    ...(typeof limit === 'number' ? { limit } : {}),
  });
  if (!Array.isArray(raw)) return [];
  return raw.filter((line): line is string => typeof line === 'string');
};

export const desktopSshLogsClear = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_logs_clear', { id });
};

export const listenDesktopSshStatus = async (
  listener: (status: DesktopSshInstanceStatus) => void,
): Promise<() => Promise<void>> => {
  if (!isTauriShell()) {
    return async () => {};
  }

  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const listen = tauri?.event?.listen;
  if (typeof listen !== 'function') {
    return async () => {};
  }

  const unlisten = await listen('openchamber:ssh-instance-status', (event) => {
    const status = parseStatus(event?.payload);
    if (!status) return;
    listener(status);
  });

  return async () => {
    await unlisten();
  };
};
