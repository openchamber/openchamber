export class CircuitBreaker {
  constructor() {
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    this.nextRetryAt = 0;
  }

  onSuccess() {
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
  }

  onFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3) {
      this.circuitOpen = true;
      this.nextRetryAt = Date.now() + Math.min(2 ** this.consecutiveFailures * 1000, 60_000);
    }
  }

  shouldSkip() {
    if (!this.circuitOpen) return false;
    if (Date.now() > this.nextRetryAt) {
      this.circuitOpen = false;
      return false;
    }
    return true;
  }
}

export class MultiServerManager {
  constructor(opts = {}) {
    this.servers = new Map();
    this.defaultServerId = opts.defaultServerId || 'local';
  }

  registerServer(config) {
    const existing = this.servers.get(config.id);
    if (existing) {
      if (config.client && existing.status !== 'connected') {
        if (existing.client && typeof existing.client.disconnect === 'function') {
          try { existing.client.disconnect(); } catch { /* ignore */ }
        }
        existing.client = config.client;
        existing.circuitBreaker = new CircuitBreaker();
        existing.errorMessage = null;
        existing.status = 'connecting';
        return existing;
      }
      existing.refCount++;
      return existing;
    }

    const entry = {
      id: config.id,
      label: config.label,
      type: config.type || 'local',
      url: config.url || null,
      status: 'connecting',
      client: config.client || null,
      refCount: 1,
      circuitBreaker: new CircuitBreaker(),
      errorMessage: null,
      lastConnectedAt: null,
    };
    this.servers.set(config.id, entry);
    return entry;
  }

  getClient(serverId) {
    return this.servers.get(serverId)?.client ?? null;
  }

  getServer(serverId) {
    return this.servers.get(serverId) ?? null;
  }

  removeServer(serverId) {
    if (serverId === 'local') {
      throw new Error('Cannot remove local server');
    }
    const entry = this.servers.get(serverId);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount <= 0) {
      if (typeof entry.client?.disconnect === 'function') {
        try { entry.client.disconnect(); } catch { /* ignore */ }
      }
      this.servers.delete(serverId);
    }
  }

  listServers() {
    return [...this.servers.values()].map((s) => ({
      id: s.id,
      label: s.label,
      type: s.type,
      status: s.status,
      url: s.url,
      errorMessage: s.errorMessage,
    }));
  }

  setDefaultServer(serverId) {
    this.defaultServerId = serverId;
  }

  getDefaultServerId() {
    return this.defaultServerId;
  }

  async getGlobalSessions(opts = {}) {
    const entries = [...this.servers.values()];
    const active = entries.filter((s) => !s.circuitBreaker.shouldSkip());

    const results = await Promise.allSettled(
      active.map(async (server) => {
        if (!server.client || typeof server.client.session?.list !== 'function') {
          throw new Error('No session client available');
        }
        const sessions = await server.client.session.list({
          archived: opts.archived,
        });
        server.circuitBreaker.onSuccess();
        return sessions.map((s) => ({ ...s, serverId: server.id }));
      }),
    );

    const all = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') all.push(...r.value);
      else {
        active[i].circuitBreaker.onFailure();
        errors.push({ serverId: active[i].id, error: r.reason?.message || String(r.reason) });
      }
    });
    return { sessions: all, errors };
  }

  async probeServer(serverId) {
    const entry = this.servers.get(serverId);
    if (!entry || !entry.client || typeof entry.client.health?.check !== 'function') return false;
    try {
      return await entry.client.health.check();
    } catch {
      return false;
    }
  }

  updateStatus(serverId, status, errorMessage = null) {
    const entry = this.servers.get(serverId);
    if (!entry) return;
    entry.status = status;
    entry.errorMessage = errorMessage;
    if (status === 'connected') entry.lastConnectedAt = Date.now();
    if (status === 'connected') entry.circuitBreaker.onSuccess();
    if (status === 'error') entry.circuitBreaker.onFailure();
  }
}
