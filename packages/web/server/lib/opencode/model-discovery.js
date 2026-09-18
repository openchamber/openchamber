/**
 * Model Discovery Service for Custom Providers
 *
 * Fetches available models from OpenAI-compatible provider /models endpoint.
 * Includes SSRF protection, timeout handling, and response validation.
 */

import { URL } from 'node:url';

// Private IP ranges to block (SSRF protection)
const PRIVATE_IP_RANGES = [
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

// Metadata endpoints to block
const METADATA_ENDPOINTS = [
  '169.254.169.254', // AWS/GCP/Azure metadata
];

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIP(hostname) {
  // Check if hostname is an IP address
  const ipMatch = hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/);
  if (!ipMatch) {
    return false;
  }
  const ipInt = ipToInt(hostname);
  return PRIVATE_IP_RANGES.some((range) => ipInt >= range.start && ipInt <= range.end);
}

function isMetadataEndpoint(hostname) {
  return METADATA_ENDPOINTS.includes(hostname);
}

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function validateBaseURL(baseURL) {
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

  // Block localhost
  if (isLocalhost(hostname)) {
    throw new DiscoveryError('Base URL cannot point to localhost', 'SSRF_BLOCKED', 400);
  }

  // Block private IPs
  if (isPrivateIP(hostname)) {
    throw new DiscoveryError('Base URL cannot point to private IP addresses', 'SSRF_BLOCKED', 400);
  }

  // Block metadata endpoints
  if (isMetadataEndpoint(hostname)) {
    throw new DiscoveryError('Base URL cannot point to metadata endpoints', 'SSRF_BLOCKED', 400);
  }

  // Block IPv6 unique local addresses (fc00::/7)
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) {
    const ipv6Match = hostname.match(/^([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$/i);
    if (ipv6Match) {
      const firstHextet = parseInt(hostname.split(':')[0], 16);
      if ((firstHextet & 0xfe00) === 0xfc00) {
        throw new DiscoveryError('Base URL cannot point to private IPv6 addresses', 'SSRF_BLOCKED', 400);
      }
    }
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

  // API key takes precedence over env (env is resolved server-side by OpenCode)
  if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
    authHeaders['Authorization'] = `Bearer ${apiKey.trim()}`;
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
  const parsedURL = validateBaseURL(baseURL);

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
    response = await fetchWithTimeout(currentURL, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...authHeaders,
      },
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
        validateBaseURL(redirectURL.toString());
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