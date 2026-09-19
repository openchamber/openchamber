/**
 * Model Discovery Service for Custom Providers
 *
 * Fetches available models from OpenAI-compatible provider /models endpoint.
 * Includes SSRF protection, timeout handling, and response validation.
 */

import { URL } from 'node:url';

// Private IP ranges to block (SSRF protection)
const PRIVATE_IP_RANGES = [
  // 0.0.0.0/8 (special "this network" addresses - includes 0.0.0.0)
  { start: ipToInt('0.0.0.0'), end: ipToInt('0.255.255.255') },
  // 10.0.0.0/8
  { start: ipToInt('10.0.0.0'), end: ipToInt('10.255.255.255') },
  // 172.16.0.0/12
  { start: ipToInt('172.16.0.0'), end: ipToInt('172.31.255.255') },
  // 192.168.0.0/16
  { start: ipToInt('192.168.0.0'), end: ipToInt('192.168.255.255') },
  // 127.0.0.0/8 (loopback)
  { start: ipToInt('127.0.0.0'), end: ipToInt('127.255.255.255') },
  // 169.254.0.0/16 (link-local)
  { start: ipToInt('169.254.0.0'), end: ipToInt('169.254.255.255') },
];

// Private IPv6 ranges to block
const PRIVATE_IPV6_RANGES = [
  // ::/128 (unspecified/loopback)
  { start: ipv6ToBigInt('::'), end: ipv6ToBigInt('::') },
  // ::1/128 (loopback)
  { start: ipv6ToBigInt('::1'), end: ipv6ToBigInt('::1') },
  // fc00::/7 (unique local addresses)
  { start: ipv6ToBigInt('fc00::'), end: ipv6ToBigInt('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') },
  // fe80::/10 (link-local)
  { start: ipv6ToBigInt('fe80::'), end: ipv6ToBigInt('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff') },
  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  { start: ipv6ToBigInt('::ffff:0:0'), end: ipv6ToBigInt('::ffff:ffff:ffff') },
];

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function ipv6ToBigInt(ipv6) {
  // Normalize IPv6 address to full 8-group form
  const normalized = normalizeIPv6(ipv6);
  const groups = normalized.split(':');
  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) + BigInt(parseInt(group, 16));
  }
  return result;
}

function normalizeIPv6(ipv6) {
  // Remove brackets if present
  let addr = ipv6.replace(/^\[|\]$/g, '');
  
  // Handle IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) - only match valid IPv4 with dots
  const ipv4MappedMatch = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4MappedMatch) {
    const ipv4 = ipv4MappedMatch[1];
    const ipv4Parts = ipv4.split('.').map(p => parseInt(p, 10).toString(16).padStart(2, '0'));
    const lastTwoGroups = ipv4Parts[0] + ipv4Parts[1] + ':' + ipv4Parts[2] + ipv4Parts[3];
    addr = '0000:0000:0000:0000:0000:ffff:' + lastTwoGroups;
  }
  
  // Handle :: compression
  if (addr.includes('::')) {
    const parts = addr.split('::');
    const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
    const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
    const missingGroups = 8 - left.length - right.length;
    const middle = Array(missingGroups).fill('0000');
    addr = [...left, ...middle, ...right].join(':');
  }
  
  // Pad each group to 4 characters
  return addr.split(':').map(g => g.padStart(4, '0')).join(':');
}

function isPrivateIPv4(hostname) {
  // Check if hostname is an IPv4 address
  const ipMatch = hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/);
  if (!ipMatch) {
    return false;
  }
  const ipInt = ipToInt(hostname);
  return PRIVATE_IP_RANGES.some((range) => ipInt >= range.start && ipInt <= range.end);
}

function isPrivateIPv6(hostname) {
  // Check if hostname is an IPv6 address (with or without brackets)
  const addr = hostname.replace(/^\[|\]$/g, '');
  if (!addr.includes(':')) {
    return false;
  }
  
  try {
    const normalized = normalizeIPv6(addr);
    const ipInt = ipv6ToBigInt(normalized);
    return PRIVATE_IPV6_RANGES.some((range) => ipInt >= range.start && ipInt <= range.end);
  } catch {
    return false;
  }
}

function isLocalhost(hostname) {
  const addr = hostname.replace(/^\[|\]$/g, '');
  return addr === 'localhost' || addr === '::1' || addr === '[::1]' || addr.endsWith('.localhost');
}

async function resolveAndValidateHostname(hostname) {
  // Remove brackets if present
  const addr = hostname.replace(/^\[|\]$/g, '');

  // If it's already an IPv4 address, validate it directly
  if (addr.match(/^(\d{1,3}\.){3}\d{1,3}$/)) {
    if (isPrivateIPv4(addr)) return false;
    if (addr === '169.254.169.254') return false;
    return true;
  }

  // Only check IPv6 if it looks like an IPv6 address (contains : and no .)
  if (addr.includes(':') && !addr.includes('.')) {
    if (isPrivateIPv6(addr)) return false;
    return true;
  }

  // For domain names, resolve and validate all resolved IPs
  try {
    const { promises: dns } = await import('node:dns');
    const result = await dns.lookup(addr, { all: true });

    for (const entry of result) {
      const ip = entry.address;

      // Check IPv4
      if (ip.includes('.') && !ip.includes(':')) {
        if (isPrivateIPv4(ip)) return false;
        if (ip === '169.254.169.254') return false;
        // Block 0.0.0.0/8
        if (ip.startsWith('0.')) return false;
      }
      // Check IPv6
      else if (ip.includes(':')) {
        if (isPrivateIPv6(ip)) return false;
        // Block ::/128 (loopback) and ::/8 (unspecified)
        if (ip === '::1' || ip === '::') return false;
      }
    }

    return true;
  } catch {
    // If DNS resolution fails, fail closed (block the request)
    // This prevents DNS rebinding attacks where an attacker causes lookup to fail
    // but then resolves to a private IP on the actual fetch
    return false;
  }
}

function isLocalhost(hostname) {
  const addr = hostname.replace(/^\[|\]$/g, '');
  return addr === 'localhost' || addr === '::1' || addr === '[::1]' || addr.endsWith('.localhost');
}

async function validateBaseURL(baseURL) {
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new DiscoveryError('Invalid Base URL format', 'INVALID_URL', 400);
  }

  // Must use HTTPS
  if (parsed.protocol !== 'https:') {
    throw new DiscoveryError('Base URL must use HTTPS', 'INVALID_URL', 400);
  }

  const hostname = parsed.hostname;

  // Block localhost and *.localhost
  if (isLocalhost(hostname)) {
    throw new DiscoveryError('Base URL cannot point to localhost', 'SSRF_BLOCKED', 400);
  }

  // Resolve hostname and validate all resolved IPs
  const isValid = await resolveAndValidateHostname(hostname);
  if (!isValid) {
    throw new DiscoveryError('Base URL cannot point to private IP addresses or metadata endpoints', 'SSRF_BLOCKED', 400);
  }

  return parsed;
}

export class DiscoveryError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function buildAuthHeaders({ apiKey, env, headers }) {
  const authHeaders = {};

  // Custom headers from provider config
  if (headers && typeof headers === 'object') {
    Object.assign(authHeaders, headers);
  }

  // API key takes precedence; if not provided, try to resolve from env var
  let resolvedApiKey = '';
  if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
    resolvedApiKey = apiKey.trim();
  } else if (env && typeof env === 'string' && env.trim()) {
    // Validate env var name - only allow alphanumeric and underscore
    // to prevent reading arbitrary environment variables
    const envName = env.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new DiscoveryError('Invalid environment variable name', 'INVALID_ENV_NAME', 400);
    }
    // Resolve environment variable server-side
    const envValue = process.env[envName];
    if (envValue && typeof envValue === 'string' && envValue.trim()) {
      resolvedApiKey = envValue.trim();
    }
  }

  if (resolvedApiKey) {
    authHeaders['Authorization'] = `Bearer ${resolvedApiKey}`;
  }

  return authHeaders;
}

function parseModelsResponse(data) {
  if (!data || typeof data !== 'object') {
    throw new DiscoveryError('The provider returned an unsupported model list format.', 'INVALID_RESPONSE', 400);
  }

  const modelsArray = data.data;
  if (!Array.isArray(modelsArray)) {
    throw new DiscoveryError('The provider returned an unsupported model list format.', 'INVALID_RESPONSE', 400);
  }

  const seen = new Set();
  const models = [];

  for (const item of modelsArray) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      continue;
    }

    // Deduplicate by id
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);

    const name = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : id;

    models.push({ id, name });
  }

  return models;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual',
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new DiscoveryError('Request timed out. The provider did not respond in time.', 'TIMEOUT', 504);
    }
    throw new DiscoveryError('Unable to connect to the provider. Please check the Base URL and network connection.', 'NETWORK_ERROR', 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverModels({ baseURL, apiKey, env, headers }) {
  // Validate Base URL (SSRF protection)
  const parsedURL = await validateBaseURL(baseURL);

  // Build models endpoint URL - ensure trailing slash to preserve base URL path
  const baseWithTrailing = parsedURL.pathname.endsWith('/') ? parsedURL : new URL(parsedURL.toString() + '/');
  const modelsURL = new URL('models', baseWithTrailing).toString();

  // Build auth headers
  const authHeaders = buildAuthHeaders({ apiKey, env, headers });

  // Fetch with timeout and redirect handling
  let response;
  let redirectCount = 0;
  let currentURL = modelsURL;

  while (redirectCount <= MAX_REDIRECTS) {
    // Build headers for this request - strip auth headers on cross-origin redirects
    const currentHost = new URL(currentURL).host;
    const requestHeaders = {
      'Accept': 'application/json',
      ...authHeaders,
    };

    response = await fetchWithTimeout(currentURL, {
      method: 'GET',
      headers: requestHeaders,
    }, DISCOVERY_TIMEOUT_MS);

    // Handle redirects manually to re-validate URL
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        break;
      }
      try {
        const redirectURL = new URL(location, currentURL);
        // Re-validate redirect target
        await validateBaseURL(redirectURL.toString());
        
        // Strip auth headers on cross-origin redirects
        const redirectHost = redirectURL.host;
        if (redirectHost !== currentHost) {
          delete authHeaders['Authorization'];
        }
        
        currentURL = redirectURL.toString();
        redirectCount++;
        continue;
      } catch (error) {
        if (error instanceof DiscoveryError && error.code === 'SSRF_BLOCKED') {
          throw error;
        }
        throw new DiscoveryError('Invalid redirect URL from provider', 'INVALID_RESPONSE', 400);
      }
    }
    break;
  }

  // Handle HTTP error statuses
  if (response.status === 401) {
    throw new DiscoveryError('Authentication failed. Please check your API key.', 'AUTH_FAILED', 401);
  }
  if (response.status === 403) {
    throw new DiscoveryError('Access denied by the provider.', 'ACCESS_DENIED', 403);
  }
  if (response.status === 404) {
    throw new DiscoveryError(`Model discovery endpoint was not found: GET ${currentURL}`, 'ENDPOINT_NOT_FOUND', 404);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new DiscoveryError(`Provider returned error ${response.status}: ${text || response.statusText}`, 'PROVIDER_ERROR', 502);
  }

  // Parse JSON response
  let data;
  try {
    data = await response.json();
  } catch {
    throw new DiscoveryError('The provider returned an unsupported model list format.', 'INVALID_RESPONSE', 400);
  }

  // Parse and validate models
  const models = parseModelsResponse(data);

  return { models };
}