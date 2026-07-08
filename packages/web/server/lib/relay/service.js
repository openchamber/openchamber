// Private relay service: config persistence, lifecycle of the relay host
// client, and the /api/openchamber/relay/* management routes.
//
// Config lives in the server settings file as `settings.privateRelay =
// { enabled, relayUrl }` (same storage precedent as tunnels/notifications).
// Routes are registered with the other OpenChamber feature routes, before the
// generic OpenCode proxy, and are covered by the same global UI auth gate.
//
// Cross-runtime parity note: relay host mode intentionally targets the web
// server runtime only in v1 (Electron shares this server in-process). The VS
// Code runtime does not host a relay; shared UI must treat these routes as
// web-runtime capabilities.

import express from 'express';

import { createRelayIdentityRuntime } from './identity.js';
import { startRelayHost } from './host-client.js';
import { bytesToBase64Url } from './e2ee.js';

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

const normalizeRelayUrl = (value) => {
  if (typeof value !== 'string') return DEFAULT_RELAY_URL;
  const trimmed = value.trim();
  if (!trimmed || !isValidRelayUrl(trimmed)) return DEFAULT_RELAY_URL;
  return trimmed;
};

// A deployment can pin the relay endpoint via env (e.g. a self-hosted relay on
// your own Cloudflare account/domain). When set and valid it overrides the
// stored setting entirely, so the host connection, the pairing offer, and the
// status all point at it — clients then inherit it from the offer automatically.
const envRelayUrlOverride = () => {
  const raw = process.env.OPENCHAMBER_RELAY_URL;
  if (typeof raw !== 'string' || !raw.trim() || !isValidRelayUrl(raw)) return null;
  return raw.trim();
};

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   os: typeof import('node:os'),
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   remoteClientAuthRuntime: { createClient: (options: object) => Promise<{ client: object, token: string }> },
 *   getLocalPort: () => number,
 *   logger?: Pick<Console, 'warn'>,
 * }} deps
 */
export const createRelayService = ({
  crypto,
  os,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
  remoteClientAuthRuntime,
  getLocalPort,
  logger = console,
}) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk });

  let hostClient = null;
  let status = { state: 'disabled', lastError: null, connectedClients: 0 };

  const readConfig = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const stored = settings?.privateRelay;
    const override = envRelayUrlOverride();
    return {
      enabled: stored?.enabled === true,
      relayUrl: override ?? normalizeRelayUrl(stored?.relayUrl),
      // True when the endpoint is pinned by OPENCHAMBER_RELAY_URL (a self-hosted
      // relay); the stored setting is ignored while it is set.
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

  const start = async (relayUrl) => {
    if (hostClient) return;
    const identity = await identityRuntime.getRelayIdentity();
    hostClient = startRelayHost({
      relayUrl,
      identity,
      getLocalPort,
      logger,
      onStatus: (next) => {
        status = next;
      },
    });
    status = hostClient.getStatus();
  };

  const stop = () => {
    if (!hostClient) return;
    hostClient.stop();
    hostClient = null;
    status = { state: 'disabled', lastError: null, connectedClients: 0 };
  };

  const startIfEnabled = async () => {
    try {
      const config = await readConfig();
      if (config.enabled) {
        await start(config.relayUrl);
      }
    } catch (error) {
      logger.warn(`[Relay] startup failed: ${error?.message ?? error}`);
    }
  };

  const getStatus = async () => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const live = hostClient ? hostClient.getStatus() : status;
    return {
      enabled: config.enabled,
      state: hostClient ? live.state : 'disabled',
      serverId: identity.serverId,
      connectedClients: live.connectedClients,
      relayUrl: config.relayUrl,
      relayUrlLocked: config.relayUrlLocked,
      ...(live.lastError ? { lastError: live.lastError } : {}),
    };
  };

  const buildOffer = async ({ includeToken = false, clientLabel } = {}) => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const offer = {
      v: 1,
      mode: 'relay',
      relayUrl: config.relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      label: os.hostname(),
    };
    if (includeToken) {
      const label = typeof clientLabel === 'string' && clientLabel.trim().length > 0
        ? clientLabel.trim()
        : 'Relay client';
      const { token } = await remoteClientAuthRuntime.createClient({ label, clientKind: 'relay' });
      offer.token = token;
    }
    const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(offer)));
    return {
      offer,
      url: `openchamber://connect?v=1&mode=relay#offer=${encoded}`,
    };
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
      try {
        const current = await readConfig();
        const relayUrl = typeof req.body?.relayUrl === 'string' ? normalizeRelayUrl(req.body.relayUrl) : current.relayUrl;
        await writeConfig({ enabled: true, relayUrl });
        if (hostClient) stop();
        await start(relayUrl);
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to enable relay' });
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

    app.post('/api/openchamber/relay/offer', express.json({ limit: '16kb' }), async (req, res) => {
      try {
        const result = await buildOffer({
          includeToken: req.body?.includeToken === true,
          clientLabel: req.body?.clientLabel,
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to build relay offer' });
      }
    });
  };

  return {
    registerRoutes,
    startIfEnabled,
    stop,
    getStatus,
    buildOffer,
  };
};
