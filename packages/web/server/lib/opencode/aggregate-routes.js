/**
 * Multi-server REST API routes.
 *
 *   GET    /api/servers               → list all servers
 *   POST   /api/servers               → register a new server (auth required)
 *   DELETE /api/servers/:serverId     → remove a server (auth required)
 *   GET    /api/servers/:serverId/health → probe server health
 *   GET    /api/servers/all/sessions  → aggregate session list across servers
 */

import { isIP } from 'node:net'
import { promises as dns } from 'node:dns'
import { CircuitBreaker } from './multi-server-manager.js'

function maskForBits(bits) {
  return (0xffffffff >>> (32 - bits)) << (32 - bits)
}

function isPrivateIp(ipStr) {
  const ipVersion = isIP(ipStr)
  if (ipVersion === 4) {
    const ipNum = ipStr.split('.').reduce((acc, octet) => (acc << 8) | (parseInt(octet, 10) & 0xff), 0) >>> 0
    if (((ipNum & maskForBits(8)) >>> 0) === (0x00000000 >>> 0)) return true    // 0.0.0.0/8
    if (((ipNum & maskForBits(8)) >>> 0) === (0x7f000000 >>> 0)) return true    // 127.0.0.0/8
    if (((ipNum & maskForBits(8)) >>> 0) === (0x0a000000 >>> 0)) return true    // 10.0.0.0/8
    if (((ipNum & maskForBits(12)) >>> 0) === (0xac100000 >>> 0)) return true   // 172.16.0.0/12
    if (((ipNum & maskForBits(16)) >>> 0) === (0xc0a80000 >>> 0)) return true   // 192.168.0.0/16
    if (((ipNum & maskForBits(16)) >>> 0) === (0xa9fe0000 >>> 0)) return true   // 169.254.0.0/16
    if (((ipNum & maskForBits(10)) >>> 0) === (0x64400000 >>> 0)) return true   // 100.64.0.0/10 (CGNAT)
    return false
  }
  if (ipVersion === 6) {
    const lower = ipStr.toLowerCase()
    if (lower === '::1') return true
    if (lower === '::ffff:127.0.0.1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (/^fe[89ab]/.test(lower)) return true
    return false
  }
  return false
}

async function isPrivateHostUrl(urlStr) {
  try {
    const parsed = new URL(urlStr)
    let hostname = parsed.hostname
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1)
    }
    if (isIP(hostname)) {
      return isPrivateIp(hostname)
    }
    try {
      const resolved = await dns.lookup(hostname, { all: false })
      if (resolved?.address && isIP(resolved.address)) {
        return isPrivateIp(resolved.address)
      }
    } catch {
      console.warn(`[aggregate-routes] DNS resolution failed for hostname "${hostname}" during SSRF check`)
      return true
    }
    return false
  } catch {
    console.warn(`[aggregate-routes] Failed to parse URL during SSRF check: "${urlStr}"`)
    return true
  }
}

async function resolveDnsAtProxyTime(hostname, urlRef) {
  if (isIP(hostname)) return hostname
  try {
    const resolved = await dns.lookup(hostname, { all: false })
    if (resolved?.address && isIP(resolved.address)) {
      return resolved.address
    }
  } catch {
    console.warn(`[aggregate-routes] DNS resolution failed at proxy time for "${hostname}"`)
  }
  return null
}

export function registerAggregateRoutes(router, serverManager, sseFanIn, getOpenCodeAuthHeaders, requireAuth) {
  const withAuth = requireAuth
    ? (req, res, next) => requireAuth(req, res, next)
    : (req, res, next) => next()

  router.get('/api/servers', (_req, res) => {
    try {
      const list = serverManager.listServers();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to list servers' });
    }
  });

  router.delete('/api/servers/:serverId', withAuth, (req, res) => {
    try {
      const { serverId } = req.params;
      if (serverId === 'local') {
        return res.status(400).json({ error: 'Cannot remove local server' });
      }

      const entry = serverManager.getServer(serverId);
      if (!entry) {
        return res.status(404).json({ error: `Server '${serverId}' not found` });
      }

      if (sseFanIn && typeof sseFanIn.unsubscribeServer === 'function') {
        try { sseFanIn.unsubscribeServer(serverId); } catch { /* ignore */ }
      }

      serverManager.removeServer(serverId);

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to remove server' });
    }
  });

  router.get('/api/servers/:serverId/health', async (req, res) => {
    try {
      const { serverId } = req.params;
      if (!serverManager.getServer(serverId)) {
        return res.status(404).json({ error: `Server '${serverId}' not found` });
      }
      const healthy = await serverManager.probeServer(serverId);
      res.json({ serverId, healthy });
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Health check failed' });
    }
  });

  router.get('/api/servers/all/sessions', async (req, res) => {
    try {
      const archived = req.query.archived === 'true';
      const result = await serverManager.getGlobalSessions({ archived });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to aggregate sessions' });
    }
  });

  router.post('/api/servers', withAuth, async (req, res) => {
    try {
      const { id: rawId, label, type, url } = req.body || {};
      const id = (typeof rawId === 'string' ? rawId : '').trim();

      if (id.length === 0) {
        return res.status(400).json({ error: 'server "id" is required' });
      }
      if (!label || typeof label !== 'string') {
        return res.status(400).json({ error: 'server "label" is required' });
      }

      const VALID_TYPES = new Set(['local', 'ssh', 'remote-url']);
      const effectiveType = type || 'remote-url';
      if (!VALID_TYPES.has(effectiveType)) {
        return res.status(400).json({ error: 'server "type" must be one of: local, ssh, remote-url' });
      }

      if (id === 'local') {
        return res.status(400).json({ error: 'Cannot re-register local server via API' });
      }

      if (url !== undefined && url !== null && typeof url !== 'string') {
        return res.status(400).json({ error: 'server "url" must be a string' });
      }

      if (url && await isPrivateHostUrl(url)) {
        return res.status(400).json({ error: 'server "url" must not be a private/internal address' });
      }

      const existing = serverManager.getServer(id);
      const isReconnect = existing && existing.status === 'disconnected';

      let client = null;
      if (url) {
        try {
          const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
          client = createOpencodeClient({ baseUrl: url });
        } catch (sdkErr) {
          console.error(`[aggregate-routes] Failed to create SDK client for '${id}':`, sdkErr?.message || sdkErr);
          return res.status(500).json({
            error: `Failed to initialize remote server connection`,
          });
        }

        try {
          await client.health.check();
        } catch (healthErr) {
          return res.status(502).json({
            error: `Remote server at "${url}" is not reachable: ${healthErr?.message || healthErr}`,
          });
        }
      }

      if (!url && !isReconnect) {
        return res.status(400).json({ error: 'server "url" is required for new servers' });
      }

      serverManager.registerServer({
        id,
        label: label.trim(),
        type: effectiveType,
        url: url || existing?.url || null,
        client,
      });

      if (sseFanIn && typeof sseFanIn.subscribeServer === 'function') {
        try {
          sseFanIn.subscribeServer(id);
        } catch (subscribeErr) {
          // Rollback: remove the server entry only if it's not already connected
          const entry = serverManager.getServer(id);
          if (entry && entry.status === 'connected') {
            return res.status(500).json({
              error: `Server registered but SSE subscription failed: ${subscribeErr?.message || subscribeErr}`,
            });
          }
          try {
            serverManager.removeServer(id);
          } catch (rollbackErr) {
            console.error(`[aggregate-routes] Rollback failed for server '${id}':`, rollbackErr?.message || rollbackErr);
          }
          return res.status(500).json({
            error: `Server registered but SSE subscription failed: ${subscribeErr?.message || subscribeErr}`,
          });
        }
      }

      const registered = serverManager.listServers().find((s) => s.id === id);
      if (!registered) {
        return res.status(500).json({ error: 'Server registered but not found in listing' });
      }
      return res.json(registered);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to register server' });
    }
  });

  // Per-server proxy circuit breaker: tracks consecutive failures per serverId
  // and fast-fails when a server is known-down instead of blocking 30s every request.
  const proxyBreakers = new Map()

  function getProxyBreaker(serverId) {
    let breaker = proxyBreakers.get(serverId)
    if (!breaker) {
      breaker = new CircuitBreaker()
      proxyBreakers.set(serverId, breaker)
    }
    return breaker
  }

  // Generic proxy middleware: forwards /api/servers/:serverId/proxy/* to the
  // corresponding remote server. The UI creates per-server OpencodeClient
  // instances pointed at /api/servers/<serverId>/proxy so all session CRUD
  // (create, delete, send, abort, etc.) routes through the correct server.
  router.use((req, res, next) => {
    const prefix = '/api/servers/'
    const url = req.path
    if (!url.startsWith(prefix)) return next()

    const afterPrefix = url.slice(prefix.length)
    const slashIndex = afterPrefix.indexOf('/')
    if (slashIndex === -1) return next()

    const serverId = afterPrefix.slice(0, slashIndex)
    const afterServerId = afterPrefix.slice(slashIndex)

    if (!afterServerId.startsWith('/proxy') && afterServerId !== '/proxy') return next()

    const remainingPath = afterServerId.slice('/proxy'.length) || '/'

    const serverEntry = serverManager.getServer(serverId)
    if (!serverEntry || !serverEntry.url) {
      return res.status(404).json({ error: `Server '${serverId}' not found or has no URL` })
    }

    // Circuit breaker: fast-fail if the circuit is open
    const breaker = getProxyBreaker(serverId)
    if (breaker.shouldSkipOrTryReset()) {
      return res.status(502).json({ error: `Proxy to '${serverId}' is temporarily unavailable` })
    }

    const client = serverManager.getClient(serverId)
    if (!client) {
      return res.status(502).json({ error: `No client available for server '${serverId}'` })
    }

    const baseUrl = serverEntry.url.replace(/\/$/, '')
    const targetUrl = `${baseUrl}${remainingPath}`
    const queryIndex = req.url.indexOf('?')
    const queryString = queryIndex !== -1 ? req.url.slice(queryIndex) : ''

    const PROXY_SAFE_HEADERS = new Set([
      'accept', 'accept-language', 'content-type', 'content-length',
      'user-agent', 'referer', 'origin', 'x-requested-with',
    ])
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (PROXY_SAFE_HEADERS.has(key.toLowerCase())) {
        headers[key] = value
      }
    }

    if (typeof getOpenCodeAuthHeaders === 'function') {
      const authHeaders = getOpenCodeAuthHeaders()
      if (authHeaders && typeof authHeaders === 'object') {
        Object.assign(headers, authHeaders)
      }
    }

    // Use req.body if body-parser already consumed the stream; otherwise read raw.
    if (req.readableEnded) {
      const body = req.body !== undefined && Object.keys(req.body).length > 0
        ? Buffer.from(JSON.stringify(req.body))
        : undefined
      void forwardRequest(body)
    } else {
      const bodyChunks = []
      req.on('data', (chunk) => bodyChunks.push(chunk))
      req.on('end', () => {
        const body = bodyChunks.length > 0
          ? Buffer.concat(bodyChunks)
          : undefined
        void forwardRequest(body)
      })
    }

    async function forwardRequest(body) {
      try {
        // DNS rebinding defense: resolve hostname at proxy time
        const parsedUrl = new URL(targetUrl)
        if (parsedUrl.hostname && !isIP(parsedUrl.hostname)) {
          const resolvedIp = await resolveDnsAtProxyTime(parsedUrl.hostname, targetUrl)
          if (!resolvedIp) {
            return res.status(502).json({ error: `Proxy to '${serverId}' failed: DNS resolution failed` })
          }
          if (isPrivateIp(resolvedIp)) {
            return res.status(502).json({ error: `Proxy to '${serverId}' failed: destination resolved to private IP` })
          }
        }

        const upstreamRes = await fetch(`${targetUrl}${queryString}`, {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.timeout(30_000),
        })

        let pumpSucceeded = false
        const resHeaders = {}
        for (const [key, value] of upstreamRes.headers.entries()) {
          const lc = key.toLowerCase()
          if (lc === 'transfer-encoding' || lc === 'set-cookie' || lc === 'content-encoding') continue
          resHeaders[key] = value
        }
        res.status(upstreamRes.status).set(resHeaders)

        if (upstreamRes.body) {
          const reader = upstreamRes.body.getReader()
          let totalBytes = 0
          const MAX_BYTES = 50 * 1024 * 1024

          // Cancel upstream read on client disconnect
          req.on('close', () => {
            try { reader.cancel() } catch { /* ignore */ }
          })

          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                res.end()
                break
              }
              totalBytes += value?.length ?? 0
              if (totalBytes > MAX_BYTES) {
                reader.cancel()
                if (!res.headersSent) {
                  res.status(502).json({ error: `Proxy response from '${serverId}' exceeded size limit` })
                } else {
                  res.end()
                }
                break
              }
              if (!res.write(value)) {
                await new Promise((resolve) => res.once('drain', resolve))
              }
            }
          }
          await pump()
          pumpSucceeded = true
        } else {
          res.end()
          pumpSucceeded = true
        }
        if (pumpSucceeded) {
          getProxyBreaker(serverId).onSuccess()
        }
      } catch (err) {
        const breaker = getProxyBreaker(serverId)
        breaker.onFailure()
        if (breaker.circuitOpen) {
          console.warn(`[aggregate-routes] Circuit breaker opened for proxy to '${serverId}' after ${breaker.consecutiveFailures} consecutive failures`)
        }
        if (!res.headersSent) {
          const detail = err?.cause?.message || err?.message || String(err)
          res.status(502).json({ error: `Proxy to '${serverId}' failed: ${detail}` })
        }
      }
    }
  })
}
