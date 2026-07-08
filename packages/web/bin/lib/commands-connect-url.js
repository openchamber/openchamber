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

// Builds an end-to-end-encrypted relay pairing link. Reuses the instance's relay
// identity (serverId + encryption public key), generating it if the relay was
// never enabled. The client reads the relay URL from the offer, so no client-side
// configuration is needed.
async function buildRelayConnectionPayload({ token, label }) {
  const accessors = createSettingsAccessors();
  const settings = await accessors.readSettingsFromDiskMigrated();
  const relayUrl = resolveRelayUrl(settings);
  const identityRuntime = createRelayIdentityRuntime({ crypto, ...accessors });
  const identity = await identityRuntime.getRelayIdentity();
  const offer = {
    v: 1,
    mode: 'relay',
    relayUrl,
    serverId: identity.serverId,
    hostEncPubJwk: identity.hostEncPubJwk,
    label,
    token,
  };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(offer)));
  return { connectUrl: `openchamber://connect?v=1&mode=relay#offer=${encoded}`, relayUrl, serverId: identity.serverId };
}

async function generateRelayConnectUrl(options) {
  const label = options.name || os.hostname();
  const runtime = createRemoteClientAuthRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(getOpenChamberDataDir(), REMOTE_CLIENTS_FILE_NAME),
  });
  const result = await runtime.createClient({ label, clientKind: 'relay' });
  const { connectUrl, relayUrl, serverId } = await buildRelayConnectionPayload({ token: result.token, label });

  if (isJsonMode(options)) {
    printJson({ mode: 'relay', relayUrl, serverId, connectUrl, token: result.token, client: result.client });
    return;
  }

  if (isQuietMode(options)) {
    process.stdout.write(`${connectUrl}\n`);
    return;
  }

  clackIntro('OpenChamber relay connect URL');
  logStatus('success', connectUrl);
  clackLog.info(`Relay: ${relayUrl}`);
  logStatus('info', '[RELAY_ENABLE]', 'Enable the relay on this instance so this link can connect (Settings -> Remote Instances).');
  clackLog.info('Copy this link into another OpenChamber client. The token is shown only once.');
  if (options.qr === true) {
    await displayTunnelQrCode(connectUrl);
  }
  clackOutro('relay connect URL generated');
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

function buildClientConnectionPayload({ serverUrl, token, label }) {
  const params = new URLSearchParams();
  params.set('v', '1');
  params.set('server', serverUrl.trim().replace(/\/+$/, ''));
  params.set('token', token.trim());
  if (label?.trim()) params.set('label', label.trim());
  return `openchamber://connect?${params.toString()}`;
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

    // Relay pairing needs neither a reachable server URL nor a running server:
    // the link is built from the instance's local relay identity + a fresh client
    // token. The client reads the relay endpoint from the offer.
    if (options.relay) {
      return await generateRelayConnectUrl(options);
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
    const label = options.name || `OpenChamber ${serverUrl}`;
    const runtime = createRemoteClientAuthRuntime({
      fsPromises: fs.promises,
      path,
      crypto,
      storePath: path.join(getOpenChamberDataDir(), REMOTE_CLIENTS_FILE_NAME),
    });
    const result = await runtime.createClient({ label });
    const connectUrl = buildClientConnectionPayload({ serverUrl, token: result.token, label });

    if (isJsonMode(options)) {
      printJson({ serverUrl, connectUrl, token: result.token, client: result.client, autoStarted: serverState.autoStarted });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`${connectUrl}\n`);
      return;
    }

    clackIntro('OpenChamber connect URL');
    if (serverState.autoStarted) {
      logStatus('success', `started OpenChamber on port ${options.port}`);
    }
    logStatus('success', connectUrl);
    clackLog.info(`Server URL: ${serverUrl}`);
    if (resolvedServerUrl.source === 'lan-detected') {
      clackLog.info('Detected a LAN address because OpenChamber is bound to all interfaces. Use --server to override it.');
    } else if (resolvedServerUrl.source === 'loopback-fallback') {
      clackLog.warn('OpenChamber is bound to all interfaces, but no LAN address was detected. Use --server to provide a reachable URL.');
    }
    clackLog.info('Copy this connection link into another OpenChamber client. The token is shown only once.');
    if (options.qr === true) {
      await displayTunnelQrCode(connectUrl);
    }
    clackOutro('connect URL generated');
  };
}

export { createConnectUrlCommand };
