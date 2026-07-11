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
import { DEFAULT_RELAY_URL } from '../../server/lib/relay/service.js';
import { bytesToBase64Url } from '../../server/lib/relay/e2ee.js';
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
const SETTINGS_FILE_NAME = 'settings.json';
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

// Resolve the relay endpoint the same way the running host does (service.js):
// OPENCHAMBER_RELAY_URL env override, then the stored setting, then the default —
// so the pairing link points at the same relay the host connects out to.
function resolveRelayUrl(settings) {
  const envUrl = process.env.OPENCHAMBER_RELAY_URL;
  if (isValidRelayUrl(envUrl)) return envUrl.trim();
  const stored = settings?.privateRelay?.relayUrl;
  if (isValidRelayUrl(stored)) return stored.trim();
  return DEFAULT_RELAY_URL;
}

// Minimal settings.json read/write for the relay identity runtime. It reads the
// whole object and writes it back with the relay keys added, so other settings
// are preserved. Enough for the CLI without wiring the full settings runtime.
function createSettingsAccessors() {
  const settingsPath = path.join(getOpenChamberDataDir(), SETTINGS_FILE_NAME);
  const readSettingsFromDiskMigrated = async () => {
    try {
      return JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
    } catch {
      return {};
    }
  };
  const writeSettingsToDisk = async (settings) => {
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  };
  return { readSettingsFromDiskMigrated, writeSettingsToDisk };
}

// Resolves the instance's relay identity (serverId + encryption public key,
// generating it if the relay was never enabled) into a pairing-v2 relay
// candidate. Relay is a transport, not a separate link format: the candidate
// carries no token — the client redeems the one-time pairing secret over the
// E2EE tunnel like any other candidate. `enabled` reports whether the host relay
// is actually on (a relay candidate only connects when the host is relaying).
async function buildRelayPairingCandidate() {
  const accessors = createSettingsAccessors();
  const settings = await accessors.readSettingsFromDiskMigrated();
  const relayUrl = resolveRelayUrl(settings);
  const identityRuntime = createRelayIdentityRuntime({ crypto, ...accessors });
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

// Pairing runtime backed by the same on-disk store the running host reads, so a
// session created here is redeemable by the live server. createPairingSession
// only writes the store (no server needed to mint); redeem is served by the host.
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

// Mirror of encodePairingConnectionPayload in @openchamber/ui (the bin cannot
// import the UI package). Keep in sync: v2 payload → base64url(JSON) in the URL
// query, so the one-time secret rides the link, never the network.
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

  // A host that's already a full http(s) URL is a public/server URL, not a bind
  // address (e.g. `--host https://devchamber.example.com` for a remote deploy
  // behind a reverse proxy). Use it directly instead of feeding it to
  // buildLocalUrl, which would produce `http://https://...:port`.
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

    // Direct candidate for the reachable server URL, plus the relay transport as
    // a fallback candidate — one link that works both on the LAN and off-network.
    // Candidate priorities make the client prefer the direct route and try the
    // relay last, mirroring the UI's "Anywhere" pairing. `--relay` opts in even
    // when the host relay is not up yet (the demand-driven lifecycle starts it);
    // otherwise the relay rides along only when it is already enabled.
    const candidates = [{ type: serverUrl.startsWith('https://') ? 'tunnel' : 'lan', url: serverUrl, priority: 10 }];
    const relay = await buildRelayPairingCandidate();
    if (options.relay || relay.enabled) candidates.push(relay.candidate);

    const pairingRuntime = createCliPairingRuntime();
    // Mark relay-carrying sessions like the server route does, so the host's
    // demand-driven relay lifecycle keeps the relay up while the link is pending.
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
      // The direct candidate points at this machine only — other devices cannot
      // use it. Say so instead of letting a "LAN" link silently not work (or a
      // --relay link silently go relay-only).
      if (options.relay) {
        logStatus('warn', '[LAN_UNREACHABLE]', 'OpenChamber only listens on this machine, so devices will always connect through the relay. Restart with --lan to allow direct home-network connections.');
      } else {
        logStatus('warn', '[LAN_UNREACHABLE]', 'OpenChamber only listens on this machine, so other devices cannot use this link. Restart with --lan, or use --server to provide a reachable URL.');
      }
    }
    clackLog.info('Scan or paste this link into another OpenChamber client. It is single-use and expires.');
    if (options.qr === true) {
      await displayTunnelQrCode(connectUrl);
    }
    clackOutro('pairing link generated');
  };
}

export { createConnectUrlCommand };
