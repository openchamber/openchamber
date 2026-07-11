import dgram from 'dgram';
import os from 'os';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import {
  getUnauthenticatedLanErrorMessage,
  isNetworkExposedBindHost,
  isUnsafeUnauthenticatedLanAllowed,
} from '../../server/lib/security/bind-host.js';

// Browser-unsafe ports (Fetch/Chromium restricted ports).
const UNSAFE_BROWSER_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);


function isUnsafeBrowserPort(port) {
  return Number.isFinite(port) && UNSAFE_BROWSER_PORTS.has(Math.trunc(port));
}

function resolveConfiguredBindHost(hostOverride) {
  const configured = typeof hostOverride === 'string' && hostOverride.trim()
    ? hostOverride.trim()
    : typeof process.env.OPENCHAMBER_HOST === 'string'
      ? process.env.OPENCHAMBER_HOST.trim()
      : '';
  return configured || '127.0.0.1';
}

function resolveServeHost(hostOverride) {
  return resolveConfiguredBindHost(hostOverride);
}

function resolveApiHost(hostOverride) {
  const configured = resolveConfiguredBindHost(hostOverride);

  if (!configured) {
    return '127.0.0.1';
  }

  // Wildcard bind hosts are not valid destination hosts.
  if (configured === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (configured === '::' || configured === '[::]') {
    return '::1';
  }

  // Strip brackets if user provided [::1]
  if (configured.startsWith('[') && configured.endsWith(']')) {
    return configured.slice(1, -1);
  }

  return configured;
}

function formatHostForUrl(host) {
  if (typeof host !== 'string') return '127.0.0.1';
  // Bracket IPv6 for URL usage.
  return host.includes(':') ? `[${host}]` : host;
}

function buildLocalUrl(port, endpoint = '', hostOverride) {
  const host = formatHostForUrl(resolveApiHost(hostOverride));
  const pathPart = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `http://${host}:${port}${pathPart}`;
}

async function detectLanIPv4Address() {
  const ip = await new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = (value) => {
      try { socket.close(); } catch {}
      resolve(value);
    };
    socket.once('error', () => finish(null));
    try {
      socket.connect(80, '8.8.8.8', (error) => {
        if (error) return finish(null);
        try {
          const addr = socket.address();
          finish(addr && typeof addr.address === 'string' ? addr.address : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });

  if (ip && ip !== '0.0.0.0' && !ip.startsWith('127.')) return ip;

  for (const entries of Object.values(os.networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        return entry.address;
      }
    }
  }
  return null;
}


function formatUnsafePortWarning(port) {
  return `Port ${port} is browser-unsafe (ERR_UNSAFE_PORT) and is not supported for OpenChamber UI at ${buildLocalUrl(port, '/')}.`;
}

function assertSafeBrowserPort(port, { context = 'This action' } = {}) {
  if (!isUnsafeBrowserPort(port)) {
    return;
  }
  throw new TunnelCliError(
    `${context} cannot use port ${port}. ${formatUnsafePortWarning(port)} Use a safe port such as 3000, 5173, 8080, or a high ephemeral port.`,
    EXIT_CODE.USAGE_ERROR,
  );
}


function hasUiPasswordConfigured(password) {
  return typeof password === 'string' && password.trim().length > 0;
}

function assertAuthenticatedNetworkExposure({ host, uiPassword }) {
  const bindHost = resolveConfiguredBindHost(host);
  if (hasUiPasswordConfigured(uiPassword)) {
    return;
  }
  if (!isNetworkExposedBindHost(bindHost)) {
    return;
  }
  if (isUnsafeUnauthenticatedLanAllowed(process.env)) {
    return;
  }
  throw new TunnelCliError(getUnauthenticatedLanErrorMessage(bindHost), EXIT_CODE.AUTH_CONFIG_ERROR);
}


export {
  resolveConfiguredBindHost,
  resolveServeHost,
  resolveApiHost,
  formatHostForUrl,
  isUnsafeBrowserPort,
  buildLocalUrl,
  detectLanIPv4Address,
  assertSafeBrowserPort,
  hasUiPasswordConfigured,
  assertAuthenticatedNetworkExposure,
};
