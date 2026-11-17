
import express from 'express';

import { createRelayIdentityRuntime } from './identity.js';
import { describeRelayError, startRelayHost } from './host-client.js';
import { isEnterpriseMode, readEnterprisePolicy } from '../enterprise-mode.js';

export const DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws';

const isValidRelayUrl = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
};

export const normalizeRelayUrl = (value) => {
  if (typeof value !== 'string') return DEFAULT_RELAY_URL;
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

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   relayKeyStore: ReturnType<typeof import('./key-store.js').createRelayKeyStore>,
 *   getLocalPort: () => number,
 *   logger?: Pick<Console, 'warn'>,
 * }} deps
 */
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
}) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, relayKeyStore });

  let hostClient = null;
  let status = { state: 'disabled', lastError: null, connectedClients: 0 };
  let claimWatchTimer = null;
  const CLAIM_WATCH_INTERVAL_MS = 30_000;
  const CLAIM_TAKEOVER_GRACE_MS = 120_000;
  let claimFreeSinceMs = null;

  const readConfig = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const stored = settings?.privateRelay;
    const override = pinnedRelayUrl();
    return {
      enabled: stored?.enabled === true,
      relayUrl: override ?? normalizeRelayUrl(stored?.relayUrl),
      relayUrlLocked: override !== null,
    };
  };

  const writeConfig = async (config) => {
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

  const standbyStatus = (holder) => ({
    state: 'standby',
    lastError: holder?.host
      ? `relay host is owned by another OpenChamber process sharing this data dir (pid ${holder.pid} on ${holder.host})`
      : 'relay host is owned by another OpenChamber process sharing this data dir',
    connectedClients: 0,
  });

  const ensureClaimWatch = (relayUrl) => {
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
    if (typeof claimWatchTimer.unref === 'function') claimWatchTimer.unref();
  };

  const stopClaimWatch = () => {
    if (!claimWatchTimer) return;
    clearInterval(claimWatchTimer);
    claimWatchTimer = null;
    claimFreeSinceMs = null;
  };

  const start = async (relayUrl, { claim = 'try' } = {}) => {
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
    hostClient = startRelayHost({
      relayUrl,
      identity,
      getLocalPort,
      logger,
      onShareState,
      onStatus: (next) => {
        status = next;
      },
    });
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

  const getStatus = async () => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const live = hostClient ? hostClient.getStatus() : status;
    return {
      enabled: config.enabled,
      state: hostClient ? live.state : (status.state === 'standby' ? 'standby' : 'disabled'),
      serverId: identity.serverId,
      connectedClients: live.connectedClients,
      relayUrl: config.relayUrl,
      relayUrlLocked: config.relayUrlLocked,
      blockedByEnterprise: relayBlockedByEnterprise(),
      identityConflict: hostClient ? live.identityConflict : false,
      ...(live.lastError ? { lastError: live.lastError } : {}),
    };
  };

  const buildPairingCandidate = async () => {
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

  const registerRoutes = (app) => {
    app.get('/api/openchamber/relay/status', async (_req, res) => {
      try {
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to read relay status' });
      }
    });

    app.post('/api/openchamber/relay/enable', express.json({ limit: '16kb' }), async (req, res) => {
      if (relayBlockedByEnterprise()) {
        return res.status(403).json({ error: RELAY_BLOCKED_ERROR, code: 'enterprise_mode' });
      }
      try {
        const current = await readConfig();
        const relayUrl = typeof req.body?.relayUrl === 'string' ? normalizeRelayUrl(req.body.relayUrl) : current.relayUrl;
        await writeConfig({ enabled: true, relayUrl });
        if (hostClient) stop();
        await start(relayUrl, { claim: 'force' });
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to enable relay' });
      }
    });

    app.post('/api/openchamber/relay/reset-identity', async (_req, res) => {
      try {
        await resetIdentity();
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to reset relay identity' });
      }
    });

    app.post('/api/openchamber/relay/disable', async (_req, res) => {
      try {
        const current = await readConfig();
        await writeConfig({ enabled: false, relayUrl: current.relayUrl });
        stop();
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to disable relay' });
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
