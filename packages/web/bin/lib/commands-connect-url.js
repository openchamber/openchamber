import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import {
  assertSafeBrowserPort,
  resolveConfiguredBindHost,
  buildLocalUrl,
  detectLanIPv4Address,
  formatHostForUrl,
} from './cli-network.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import { getInstanceFilePath, readInstanceOptions } from './cli-process.js';
import { createRemoteClientAuthRuntime } from '../../server/lib/client-auth/remote-clients.js';
import { createClientPairingRuntime } from '../../server/lib/client-auth/pairing.js';
import { createRelayIdentityRuntime } from '../../server/lib/relay/identity.js';
import { createRelayKeyStore } from '../../server/lib/relay/key-store.js';
import { DEFAULT_RELAY_URL, pinnedRelayUrl } from '../../server/lib/relay/service.js';
import { bytesToBase64Url } from '../../server/lib/relay/e2ee.js';
import { createSettingsAccessors as createSettingsAccessorsModule } from './cli-settings-accessors.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  log as clackLog,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

const REMOTE_CLIENTS_FILE_NAME = 'remote-clients.json';
const PAIRING_SESSIONS_FILE_NAME = 'client-pairing-sessions.json';

function isValidRelayUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

function resolveRelayUrl(settings) {
  const pinned = pinnedRelayUrl();
  if (pinned) return pinned;
  const stored = settings?.privateRelay?.relayUrl;
  if (isValidRelayUrl(stored)) return stored.trim();
  return DEFAULT_RELAY_URL;
}

function createSettingsAccessors() {
  return createSettingsAccessorsModule({
    fsPromises: fs.promises,
    path,
    dataDir: getOpenChamberDataDir(),
    settingsFileName: 'settings.json',
  });
}

async function buildRelayPairingCandidate() {
  const accessors = createSettingsAccessors();
  const settings = await accessors.readSettingsFromDiskMigrated();
  const relayUrl = resolveRelayUrl(settings);
  const relayKeyStore = createRelayKeyStore({
    fsPromises: fs.promises,
    path,
    dataDir: getOpenChamberDataDir(),
    ...accessors,
  });
  const identityRuntime = createRelayIdentityRuntime({ crypto, relayKeyStore });
  const identity = await identityRuntime.getRelayIdentity();
  return {
    enabled: settings?.privateRelay?.enabled === true,
    relayUrl,
    serverId: identity.serverId,
    candidate: {
      type: 'relay',
      relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    },
  };
}

function createCliPairingRuntime() {
  const dataDir = getOpenChamberDataDir();
  const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(dataDir, REMOTE_CLIENTS_FILE_NAME),
  });
  return createClientPairingRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(dataDir, PAIRING_SESSIONS_FILE_NAME),
    remoteClientAuthRuntime,
  });
}

function encodePairingConnectUrl(payload) {
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `openchamber://connect?v=2&p=${encoded}`;
}

function buildPairingPayload({ pairing, label, candidates }) {
  return {
    v: 2,
    pairingId: pairing.id,
    secret: pairing.secret,
    ...(label ? { label } : {}),
    ...(pairing.fingerprint ? { fingerprint: pairing.fingerprint } : {}),
    ...(pairing.expiresAt ? { expiresAt: pairing.expiresAt } : {}),
    candidates,
  };
}

async function resolveConnectUrlServerUrl(options) {
  let hostOverride = options.host;
  if (typeof hostOverride !== 'string' && !process.env.OPENCHAMBER_HOST) {
    const storedOptions = readInstanceOptions(await getInstanceFilePath(options.port));
    if (typeof storedOptions?.host === 'string' && storedOptions.host.trim()) {
      hostOverride = storedOptions.host.trim();
    }
  }

  const bindHost = resolveConfiguredBindHost(hostOverride);

  const hostAsServerUrl = normalizeServerUrlForConnection(bindHost);
  if (hostAsServerUrl) {
    return { serverUrl: hostAsServerUrl, source: 'configured-host' };
  }

  if (!isWildcardBindHost(bindHost)) {
    return {
      serverUrl: buildLocalUrl(options.port, '/', hostOverride).replace(/\/+$/, ''),
      source: 'configured-host',
    };
  }

  const lanAddress = await detectLanIPv4Address();
  if (!lanAddress) {
    return {
      serverUrl: buildLocalUrl(options.port, '/').replace(/\/+$/, ''),
      source: 'loopback-fallback',
    };
  }

  return {
    serverUrl: `http://${formatHostForUrl(lanAddress)}:${options.port}`,
    source: 'lan-detected',
  };
}

function isWildcardBindHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isLoopbackServerUrl(serverUrl) {
  try {
    const hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function normalizeServerUrlForConnection(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function getOpenChamberDataDir() {
  return process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
}

async function displayTunnelQrCode(url) {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    console.warn(`Warning: Could not generate QR code: ${error.message}`);
  }
}

function createConnectUrlCommand({ serveCommand }) {
  return async function connectUrlCommand(options = {}) {
    assertSafeBrowserPort(options.port, { context: 'OpenChamber connect-url' });
    const explicitServerUrl = options.server ? normalizeServerUrlForConnection(options.server) : null;
    if (options.server && !explicitServerUrl) {
      throw new TunnelCliError('Invalid --server URL. Use an http:// or https:// URL.', EXIT_CODE.USAGE_ERROR);
    }

    const running = await discoverRunningInstances();
    const serverState = running.some((entry) => entry.port === options.port)
      ? { port: options.port, autoStarted: false }
      : await (async () => {
          await serveCommand({
            port: options.port,
            explicitPort: true,
            host: options.host,
            uiPassword: options.uiPassword,
            apiOnly: options.apiOnly,
            suppressUnsafePortWarning: true,
            suppressUiPasswordWarning: true,
            suppressStartupSummary: true,
            suppressQuietOutput: true,
          });
          return { port: options.port, autoStarted: true };
        })();

    const resolvedServerUrl = explicitServerUrl
      ? { serverUrl: explicitServerUrl, source: 'explicit' }
      : await resolveConnectUrlServerUrl(options);
    const serverUrl = resolvedServerUrl.serverUrl;
    const label = options.name || os.hostname();

    const candidates = [{ type: serverUrl.startsWith('https://') ? 'tunnel' : 'lan', url: serverUrl, priority: 10 }];
    const relay = await buildRelayPairingCandidate();
    if (options.relay || relay.enabled) candidates.push(relay.candidate);

    const pairingRuntime = createCliPairingRuntime();
    const usesRelay = candidates.some((candidate) => candidate.type === 'relay');
    const { pairing } = await pairingRuntime.createPairingSession({ label, usesRelay });
    const connectUrl = encodePairingConnectUrl(buildPairingPayload({ pairing, label, candidates }));

    if (isJsonMode(options)) {
      printJson({
        serverUrl,
        connectUrl,
        pairingId: pairing.id,
        fingerprint: pairing.fingerprint,
        expiresAt: pairing.expiresAt,
        candidates,
        autoStarted: serverState.autoStarted,
      });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`${connectUrl}\n`);
      return;
    }

    clackIntro('OpenChamber pairing link');
    if (serverState.autoStarted) {
      logStatus('success', `started OpenChamber on port ${options.port}`);
    }
    logStatus('success', connectUrl);
    clackLog.info(`Server URL: ${serverUrl}`);
    if (options.relay || relay.enabled) {
      clackLog.info(`Relay fallback: ${relay.relayUrl}`);
    }
    if (options.relay && !relay.enabled) {
      logStatus('info', '[RELAY_STARTING]', 'Relay is not up yet. A running instance starts it within a minute; a stopped instance starts it on next launch.');
    }
    if (pairing.fingerprint) {
      clackLog.info(`Fingerprint: ${pairing.fingerprint}`);
    }
    if (resolvedServerUrl.source === 'lan-detected') {
      clackLog.info('Detected a LAN address because OpenChamber is bound to all interfaces. Use --server to override it.');
    } else if (resolvedServerUrl.source === 'loopback-fallback') {
      clackLog.warn('OpenChamber is bound to all interfaces, but no LAN address was detected. Use --server to provide a reachable URL.');
    } else if (isLoopbackServerUrl(serverUrl)) {
      logStatus('info', '[LOOPBACK_URL]', 'This link uses localhost for direct connections. For another device, use --server with a reachable address or include --relay.');
    }
    clackLog.info('Scan or paste this link into another OpenChamber client. It is single-use and expires.');
    if (options.qr === true) {
      await displayTunnelQrCode(connectUrl);
    }
    clackOutro('pairing link generated');
  };
}

export { createConnectUrlCommand };
