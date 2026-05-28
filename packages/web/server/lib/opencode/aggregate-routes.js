/**
 * Multi-server REST API routes.
 *
 *   GET    /api/servers               → list all servers
 *   POST   /api/servers               → register a new server
 *   DELETE /api/servers/:serverId     → remove a server
 *   GET    /api/servers/:serverId/health → probe server health
 *   GET    /api/servers/all/sessions  → aggregate session list across servers
 */

export function registerAggregateRoutes(router, serverManager, sseFanIn) {
  router.get('/api/servers', (_req, res) => {
    try {
      const list = serverManager.listServers();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Failed to list servers' });
    }
  });

  router.delete('/api/servers/:serverId', (req, res) => {
    try {
      const { serverId } = req.params;
      if (serverId === 'local') {
        return res.status(400).json({ error: 'Cannot remove local server' });
      }

      const entry = serverManager.getServer(serverId);
      if (!entry) {
        return res.status(404).json({ error: `Server '${serverId}' not found` });
      }

      serverManager.removeServer(serverId);

      if (sseFanIn && typeof sseFanIn.unsubscribeServer === 'function') {
        sseFanIn.unsubscribeServer(serverId);
      }

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

  router.post('/api/servers', async (req, res) => {
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

      const existing = serverManager.getServer(id);
      const isReconnect = existing && existing.status === 'disconnected';

      let client = null;
      if (url) {
        // TODO: create OpencodeClient for remote server URL
        // const { createOpencodeClient } = await import('@opencode-ai/sdk');
        // client = createOpencodeClient({ baseUrl: url });
        // await client.health.check();
        return res.status(501).json({
          error: 'Remote server registration requires SDK integration (not yet implemented)',
          hint: 'Use the desktop Electron shell to connect via SSH tunnel',
        });
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
          // Rollback: remove the server entry on SSE subscription failure
          try { serverManager.removeServer(id); } catch { /* best-effort */ }
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
}
