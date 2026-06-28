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

async function resolveConnectUrlServerUrl(options) {
  let hostOverride = options.host;
  if (typeof hostOverride !== 'string' && !process.env.OPENCHAMBER_HOST) {
    const storedOptions = readInstanceOptions(await getInstanceFilePath(options.port));
    if (typeof storedOptions?.host === 'string' && storedOptions.host.trim()) {
      hostOverride = storedOptions.host.trim();
    }
  }

  const bindHost = resolveConfiguredBindHost(hostOverride);
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
