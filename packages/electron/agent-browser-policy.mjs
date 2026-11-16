import { z } from 'zod';

export const BROWSER_PANEL_PARTITION = 'persist:openchamber-browser';
export const AGENT_BROWSER_PARTITION = 'persist:openchamber-browser-agent';

export const isStandaloneBrowserPanelPartition = (partition) => (
  partition === BROWSER_PANEL_PARTITION || partition === AGENT_BROWSER_PARTITION
);

const canonicalHostname = (hostname) => {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  // WHATWG URL canonicalizes numeric IPv4 and compresses IPv6. Collapse mapped
  // IPv4 too, so [::ffff:7f00:1] cannot evade an IPv4 endpoint or loopback rule.
  const mapped = /^\[::ffff:([\da-f]+):([\da-f]+)\]$/.exec(host);
  if (!mapped) return host;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};

const networkAddress = (raw) => {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
    const hostname = canonicalHostname(url.hostname);
    const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
    return { hostname, port, endpoint: `${hostname}:${port}` };
  } catch {
    return null;
  }
};

const isLoopback = (hostname) => (
  hostname === 'localhost' || hostname.endsWith('.localhost')
  || /^127\./.test(hostname) || hostname === '[::1]'
  || hostname === '0.0.0.0' || hostname === '[::]'
);

const CONNECTION_URL_KEY = /^(?:url|apiUrl|urls|apiUrls|localUrl|lanUrl|tunnelUrl|publicUrl|serverUrl|baseUrl)$/i;
// The two kinds of value the walk below reads from the settings JSON: text, and an object to descend into.
const textSchema = z.string();
const recordSchema = z.record(z.string(), z.unknown());
// A managed tunnel's hostname from the settings, or its URL; anything else there is skipped.
const tunnelHostnameSchema = z.string().min(1);

// Connection records contain credentials as well as addresses. Only named URL
// fields contribute endpoints, including nested LAN/tunnel candidate records.
const collectConnectionUrls = (value, urls, isUrlField = false) => {
  if (textSchema.safeParse(value).success) {
    if (isUrlField) urls.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectConnectionUrls(entry, urls, isUrlField);
  } else if (recordSchema.safeParse(value).success) {
    // The entries of the value itself: zod's copy would drop an own `__proto__` key and what it holds.
    for (const [key, entry] of Object.entries(value)) {
      collectConnectionUrls(entry, urls, CONNECTION_URL_KEY.test(key));
    }
  }
};

export const buildAgentBrowserPolicy = ({ serverUrls = [], tunnelHostnames = [], connectionSettings = {}, localAddresses = [], localPorts = [] } = {}) => {
  const urls = [...serverUrls, ...tunnelHostnames.filter((hostname) => tunnelHostnameSchema.safeParse(hostname).success)
    .map((hostname) => hostname.includes('://') ? hostname : `https://${hostname}`)];
  collectConnectionUrls(connectionSettings, urls);
  const endpoints = new Set();
  const ports = new Set(localPorts.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535).map(String));
  for (const raw of urls) {
    const address = networkAddress(raw);
    if (!address) continue;
    endpoints.add(address.endpoint);
    ports.add(address.port);
  }
  const localHosts = new Set(localAddresses.map((address) => {
    const bracketed = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
    return networkAddress(`http://${bracketed}`)?.hostname;
  }).filter(Boolean));
  return { endpoints, ports, localHosts };
};

export const shouldCancelAgentBrowserRequest = ({ partition, url, policy }) => {
  if (partition !== AGENT_BROWSER_PARTITION) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol === 'blob:') {
    return shouldCancelAgentBrowserRequest({ partition, url: parsed.pathname, policy });
  }
  if (parsed.protocol === 'about:') return parsed.pathname !== 'blank' && parsed.pathname !== 'srcdoc';
  if (parsed.protocol === 'data:') return false;
  const address = networkAddress(url);
  if (!address) return true;
  return policy.endpoints.has(address.endpoint)
    || (policy.ports.has(address.port) && (isLoopback(address.hostname) || policy.localHosts.has(address.hostname)));
};
