import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { CliOptions } from './cli-args.js';
import type { createServeCommand } from './commands-serve.js';
import type { PairingSession } from '../../server/lib/client-auth/contracts.js';
import type { RelayPublicJwk } from '../../server/lib/relay/key-store.js';
import type { JsonValue } from '../../server/lib/shared/json-values.js';
import { isString } from '../../server/lib/shared/object-guards.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import {
  assertSafeBrowserPort,
  resolveConfiguredBindHost,
  buildLocalUrl,
  detectLanIPv4Address,
  formatHostForUrl,
} from './cli-network.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import { getInstanceFilePath, hasInstanceFields, readInstanceOptions } from './cli-process.js';
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

export type ConnectUrlOptions = Pick<Partial<CliOptions>, 'port' | 'host' | 'server' | 'name' | 'relay' | 'json' | 'quiet' | 'qr' | 'uiPassword' | 'apiOnly'>;
export interface ConnectUrlDependencies {
  serveCommand: ReturnType<typeof createServeCommand>;
}
type RelayCandidate = { type: 'relay'; relayUrl: string; serverId: string; hostEncPubJwk: { [Key in keyof RelayPublicJwk]: RelayPublicJwk[Key] }; priority: number };
type ConnectCandidate = { type: 'lan' | 'tunnel'; url: string; priority: number } | RelayCandidate;
type PairingPayloadInput = {
  pairing: Pick<PairingSession, 'id' | 'fingerprint' | 'expiresAt'> & { secret: string };
  label: string;
  candidates: ConnectCandidate[];
};
type PairingPayloadFields = {
  v: number;
  pairingId: string;
  secret: string;
  label?: string;
  fingerprint?: string;
  expiresAt?: string;
};

function hasRelaySettings(value: JsonValue): value is JsonValue & { privateRelay?: JsonValue } {
  return value !== null;
}

function hasRelayFields(value: JsonValue | undefined): value is JsonValue & { relayUrl?: JsonValue; enabled?: JsonValue } {
  return value !== null && value !== undefined;
}

function isValidRelayUrl(value: JsonValue | undefined): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

function resolveRelayUrl(settings: JsonValue) {
  const pinned = pinnedRelayUrl();
  if (pinned) return pinned;
  const privateRelay = hasRelaySettings(settings) ? settings.privateRelay : undefined;
  const stored = hasRelayFields(privateRelay) ? privateRelay.relayUrl : undefined;
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

async function buildRelayPairingCandidate(): Promise<{ enabled: boolean; relayUrl: string; serverId: string; candidate: RelayCandidate }> {
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
  const privateRelay = hasRelaySettings(settings) ? settings.privateRelay : undefined;
  return {
    enabled: hasRelayFields(privateRelay) && privateRelay.enabled === true,
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

function encodePairingConnectUrl(payload: ReturnType<typeof buildPairingPayload>) {
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `openchamber://connect?v=2&p=${encoded}`;
}

function buildPairingPayload({ pairing, label, candidates }: PairingPayloadInput) {
  const payload: PairingPayloadFields = {
    v: 2,
    pairingId: pairing.id,
    secret: pairing.secret,
  };
  if (label) payload.label = label;
  if (pairing.fingerprint) payload.fingerprint = pairing.fingerprint;
  if (pairing.expiresAt) payload.expiresAt = pairing.expiresAt;
  return { ...payload, candidates };
}

async function resolveConnectUrlServerUrl(options: ConnectUrlOptions) {
  let hostOverride = options.host;
  if (!isString(hostOverride) && !process.env.OPENCHAMBER_HOST) {
    const storedOptions = readInstanceOptions(await getInstanceFilePath(options.port));
    if (hasInstanceFields(storedOptions) && isString(storedOptions.host) && storedOptions.host.trim()) {
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

function isWildcardBindHost(host: string) {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isLoopbackServerUrl(serverUrl: string) {
  try {
    const hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function normalizeServerUrlForConnection(value: string) {
  const trimmed = isString(value) ? value.trim() : '';
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

function assertQrFailure(error: unknown): asserts error is { message?: unknown } {
  if (error === null || error === undefined) {
    if ('Bun' in globalThis) {
      throw new TypeError(`${error} is not an object (evaluating 'error.message')`);
    }
    throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
  }
}

async function displayTunnelQrCode(url: string) {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    assertQrFailure(error);
    console.warn(`Warning: Could not generate QR code: ${error.message}`);
  }
}

function createConnectUrlCommand({ serveCommand }: ConnectUrlDependencies) {
  return async function connectUrlCommand(options: ConnectUrlOptions = {}) {
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

    const candidates: ConnectCandidate[] = [{ type: serverUrl.startsWith('https://') ? 'tunnel' : 'lan', url: serverUrl, priority: 10 }];
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
