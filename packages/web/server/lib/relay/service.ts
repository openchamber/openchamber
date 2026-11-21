
import express from 'express';
import type { Server } from 'node:http';

import { createRelayIdentityRuntime } from './identity.js';
import { describeRelayError, startRelayHost } from './host-client.js';
import { consumeRelayProof } from './provenance.js';
import { isEnterpriseMode, readEnterprisePolicy } from '../enterprise-mode.js';
import type { Application } from '../shared/http-contracts.js';
import type { RelaySigningDependencies } from './signing-key.js';
import type { RelayLegacySettings, RelayPublicJwk } from './key-store.js';
import type { RelayHostLock } from './host-lock.js';

export interface RelayServiceDependencies extends RelaySigningDependencies {
  readSettingsFromDiskMigrated: () => Promise<RelayLegacySettings>;
  writeSettingsToDisk: (settings: RelayLegacySettings) => Promise<void>;
  getLocalPort: () => number;
  hasRelayDemand?: () => Promise<boolean>;
  hostLock?: RelayHostLock | null;
  allowPassiveHost?: boolean;
  onShareState?: (shareId: string) => void;
  logger?: Pick<Console, 'warn'>;
}

export interface RelayServiceStatus {
  state: string;
  lastError: string | null;
  connectedClients: number;
  identityConflict?: boolean;
}

export interface RelayPairingCandidate {
  type: 'relay';
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: RelayPublicJwk;
  priority: number;
}

export interface RelayStatus {
  enabled: boolean;
  state: string;
  serverId: string;
  connectedClients: number;
  relayUrl: string;
  relayUrlLocked: boolean;
  blockedByEnterprise: boolean;
  identityConflict: boolean | undefined;
  lastError?: string;
}

interface RelayConfig {
  enabled: boolean;
  relayUrl: string;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const hasRelayConfigFields = (value: unknown): value is { enabled?: unknown; relayUrl?: unknown } =>
  value !== null && value !== undefined;
const hasRelayUrlField = (value: unknown): value is { relayUrl?: unknown } =>
  value !== null && value !== undefined;
const hasErrorMessage = (value: unknown): value is { message?: unknown } => value !== null && value !== undefined;

export const DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws';

const isValidRelayUrl = (value: unknown): value is string => {
  if (!isString(value)) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
};

export const normalizeRelayUrl = (value: string | null | undefined) => {
  if (!isString(value)) return DEFAULT_RELAY_URL;
  const trimmed = value.trim();
  if (!trimmed || !isValidRelayUrl(trimmed)) return DEFAULT_RELAY_URL;
  return trimmed;
};

export const pinnedRelayUrl = () => {
  const raw = readEnterprisePolicy().relayUrl;
  return raw && isValidRelayUrl(raw) ? raw.trim() : null;
};

const RELAY_BLOCKED_ERROR = 'In enterprise mode the relay runs on your own endpoint: set relayUrl in the policy file or OPENCHAMBER_RELAY_URL to a self-hosted relay.';
export const relayBlockedByEnterprise = () => isEnterpriseMode() && pinnedRelayUrl() === null;

export const createRelayService = ({
  crypto,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
  relayKeyStore,
  getLocalPort,
  hasRelayDemand = async () => false,
  hostLock = null,
  allowPassiveHost = true,
  onShareState = () => {},
  logger = console,
}: RelayServiceDependencies) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, relayKeyStore });

  let hostClient: ReturnType<typeof startRelayHost> | null = null;
  let status: RelayServiceStatus = { state: 'disabled', lastError: null, connectedClients: 0 };
  let claimWatchTimer: ReturnType<typeof setInterval> | null = null;
  const CLAIM_WATCH_INTERVAL_MS = 30_000;
  const CLAIM_TAKEOVER_GRACE_MS = 120_000;
  let claimFreeSinceMs: number | null = null;

  const readConfig = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const rawStored = settings?.privateRelay;
    const stored = hasRelayConfigFields(rawStored) ? rawStored : null;
    const override = pinnedRelayUrl();
    return {
      enabled: stored?.enabled === true,
      relayUrl: override ?? normalizeRelayUrl(isString(stored?.relayUrl) ? stored.relayUrl : undefined),
      relayUrlLocked: override !== null,
    };
  };

  const writeConfig = async (config: RelayConfig) => {
    const settings = await readSettingsFromDiskMigrated();
    await writeSettingsToDisk({
      ...settings,
      privateRelay: { enabled: config.enabled === true, relayUrl: normalizeRelayUrl(config.relayUrl) },
    });
  };

  const stopHostClient = () => {
    if (!hostClient) return;
    hostClient.stop();
    hostClient = null;
  };

  const standbyStatus = (holder: ReturnType<RelayHostLock['otherLiveClaimant']>) => ({
    state: 'standby',
    lastError: holder?.host
      ? `relay host is owned by another OpenChamber process sharing this data dir (pid ${holder.pid} on ${holder.host})`
      : 'relay host is owned by another OpenChamber process sharing this data dir',
    connectedClients: 0,
  });

  const ensureClaimWatch = (relayUrl: string) => {
    if (!hostLock || claimWatchTimer) return;
    claimWatchTimer = setInterval(() => {
      void (async () => {
        try {
          if (hostClient) {
            if (!hostLock.tryClaim()) {
              logger.warn('[Relay] host claim taken by another instance — standing down');
              stopHostClient();
              status = standbyStatus(hostLock.otherLiveClaimant());
            }
            return;
          }
          if (status.state !== 'standby' || !allowPassiveHost) return;
          if (hostLock.otherLiveClaimant() !== null) {
            claimFreeSinceMs = null;
            return;
          }
          if (claimFreeSinceMs === null) {
            claimFreeSinceMs = Date.now();
            return;
          }
          if (Date.now() - claimFreeSinceMs < CLAIM_TAKEOVER_GRACE_MS) return;
          if (hostLock.tryClaim()) {
            claimFreeSinceMs = null;
            logger.warn('[Relay] host claim stayed free — taking over the relay host');
            await start(relayUrl);
          }
        } catch (error) {
          logger.warn(`[Relay] claim watch failed: ${describeRelayError(error)}`);
        }
      })();
    }, CLAIM_WATCH_INTERVAL_MS);
    claimWatchTimer.unref();
  };

  const stopClaimWatch = () => {
    if (!claimWatchTimer) return;
    clearInterval(claimWatchTimer);
    claimWatchTimer = null;
    claimFreeSinceMs = null;
  };

  const start = async (relayUrl: string, { claim = 'try' }: { claim?: 'try' | 'force' } = {}) => {
    if (hostClient) return;
    if (relayBlockedByEnterprise()) {
      status = { state: 'disabled', lastError: RELAY_BLOCKED_ERROR, connectedClients: 0 };
      return;
    }
    if (claim !== 'force' && !allowPassiveHost) {
      status = {
        state: 'standby',
        lastError: 'passive relay hosting is disabled on this instance — enable the relay or create a pairing link to host here',
        connectedClients: 0,
      };
      return;
    }
    if (hostLock) {
      const claimed = claim === 'force' ? hostLock.forceClaim() : hostLock.tryClaim();
      if (!claimed) {
        status = standbyStatus(hostLock.otherLiveClaimant());
        ensureClaimWatch(relayUrl);
        return;
      }
    }
    const identity = await identityRuntime.getRelayIdentity();
    const hostOptions = {
      relayUrl,
      identity,
      getLocalPort,
      logger,
      onShareState,
      onStatus: (next: RelayServiceStatus) => {
        status = next;
      },
    };
    hostClient = startRelayHost(hostOptions);
    status = hostClient.getStatus();
    ensureClaimWatch(relayUrl);
  };

  const stop = () => {
    stopClaimWatch();
    stopHostClient();
    if (hostLock) hostLock.release();
    status = { state: 'disabled', lastError: null, connectedClients: 0 };
  };

  const startIfEnabled = async () => {
    try {
      const config = await readConfig();
      if (config.enabled) {
        await start(config.relayUrl);
      }
    } catch (error) {
      logger.warn(`[Relay] startup failed: ${describeRelayError(error)}`);
    }
  };

  const reconcile = async () => {
    try {
      const demand = await hasRelayDemand();
      const config = await readConfig();
      if (demand) {
        if (!config.enabled) await writeConfig({ enabled: true, relayUrl: config.relayUrl });
        if (!hostClient) {
          const next = await readConfig();
          await start(next.relayUrl);
        }
      } else {
        if (config.enabled) await writeConfig({ enabled: false, relayUrl: config.relayUrl });
        stop();
      }
    } catch (error) {
      logger.warn(`[Relay] reconcile failed: ${describeRelayError(error)}`);
    }
  };

  const getServerId = async () => {
    const identity = await identityRuntime.getRelayIdentity();
    return identity.serverId;
  };

  const getStatus = async (): Promise<RelayStatus> => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const live: RelayServiceStatus = hostClient ? hostClient.getStatus() : status;
    const result: RelayStatus = {
      enabled: config.enabled,
      state: hostClient ? live.state : (status.state === 'standby' ? 'standby' : 'disabled'),
      serverId: identity.serverId,
      connectedClients: live.connectedClients,
      relayUrl: config.relayUrl,
      relayUrlLocked: config.relayUrlLocked,
      blockedByEnterprise: relayBlockedByEnterprise(),
      identityConflict: hostClient ? live.identityConflict : false,
    };
    if (live.lastError) result.lastError = live.lastError;
    return result;
  };

  const buildPairingCandidate = async (): Promise<RelayPairingCandidate> => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    return {
      type: 'relay',
      relayUrl: config.relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    };
  };

  const getPairingCandidate = async () => {
    const config = await readConfig();
    if (!config.enabled || relayBlockedByEnterprise()) return null;
    return buildPairingCandidate();
  };

  const ensureEnabledForPairing = async () => {
    if (relayBlockedByEnterprise()) throw Object.assign(new Error(RELAY_BLOCKED_ERROR), { statusCode: 403 });
    const config = await readConfig();
    if (!config.enabled) {
      await writeConfig({ enabled: true, relayUrl: config.relayUrl });
    }
    if (!hostClient) {
      const next = await readConfig();
      await start(next.relayUrl, { claim: 'force' });
    }
    return buildPairingCandidate();
  };

  const resetIdentity = async () => {
    const wasHosting = hostClient !== null;
    stopHostClient();
    await relayKeyStore.reset();
    if (wasHosting) await start((await readConfig()).relayUrl);
  };

  const registerRoutes = (app: Application, server: Server) => {
    server.prependListener('request', consumeRelayProof);
    server.prependListener('upgrade', consumeRelayProof);
    app.get('/api/openchamber/relay/status', async (_req, res) => {
      try {
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: (hasErrorMessage(error) ? error.message : undefined) ?? 'Failed to read relay status' });
      }
    });

    app.post('/api/openchamber/relay/enable', express.json({ limit: '16kb' }), async (req, res) => {
      if (relayBlockedByEnterprise()) {
        return res.status(403).json({ error: RELAY_BLOCKED_ERROR, code: 'enterprise_mode' });
      }
      try {
        const current = await readConfig();
        const rawRelayUrl = hasRelayUrlField(req.body) ? req.body.relayUrl : undefined;
        const relayUrl = isString(rawRelayUrl) ? normalizeRelayUrl(rawRelayUrl) : current.relayUrl;
        await writeConfig({ enabled: true, relayUrl });
        if (hostClient) stop();
        await start(relayUrl, { claim: 'force' });
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: (hasErrorMessage(error) ? error.message : undefined) ?? 'Failed to enable relay' });
      }
    });

    app.post('/api/openchamber/relay/reset-identity', async (_req, res) => {
      try {
        await resetIdentity();
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: (hasErrorMessage(error) ? error.message : undefined) ?? 'Failed to reset relay identity' });
      }
    });

    app.post('/api/openchamber/relay/disable', async (_req, res) => {
      try {
        const current = await readConfig();
        await writeConfig({ enabled: false, relayUrl: current.relayUrl });
        stop();
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: (hasErrorMessage(error) ? error.message : undefined) ?? 'Failed to disable relay' });
      }
    });

  };

  return {
    registerRoutes,
    startIfEnabled,
    reconcile,
    stop,
    getStatus,
    getServerId,
    resetIdentity,
    getPairingCandidate,
    ensureEnabledForPairing,
  };
};
