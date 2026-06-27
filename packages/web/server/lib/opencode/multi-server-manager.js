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
    this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 20);
    if (this.consecutiveFailures >= 3) {
      this.circuitOpen = true;
      this.nextRetryAt = Date.now() + Math.min(2 ** this.consecutiveFailures * 1000, 60_000);
    }
  }

  // Returns true if this breaker is open and should skip the operation.
  // As a side effect, resets the breaker if the retry window has expired.
  // Callers must be aware that this predicate mutates state.
  shouldSkipOrTryReset() {
    if (!this.circuitOpen) return false;
    if (Date.now() > this.nextRetryAt) {
      this.circuitOpen = false;
      this.consecutiveFailures = 0;
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
          try { existing.client.disconnect(); } catch (err) { console.warn(`[MultiServerManager] disconnect failed for '${config.id}':`, err?.message || err); }
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
    const entriesSnap = [...this.servers.values()].filter((s) => !s.circuitBreaker.circuitOpen || Date.now() > s.circuitBreaker.nextRetryAt);
    for (const s of entriesSnap) {
      if (s.circuitBreaker.circuitOpen && Date.now() > s.circuitBreaker.nextRetryAt) {
        s.circuitBreaker.circuitOpen = false;
        s.circuitBreaker.consecutiveFailures = 0;
      }
    }
    const activeSnap = new Map(entriesSnap.map((s, i) => [i, s]));

    const results = await Promise.allSettled(
      entriesSnap.map(async (server) => {
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
        const server = activeSnap.get(i);
        if (server) {
          server.circuitBreaker.onFailure();
          errors.push({ serverId: server.id, error: r.reason?.message || String(r.reason) });
        }
      }
    });
    return { sessions: all, errors };
  }

  async probeServer(serverId) {
    const entry = this.servers.get(serverId);
    if (!entry || !entry.client || typeof entry.client.health?.check !== 'function') return false;
    try {
      const result = await entry.client.health.check();
      return !!result;
    } catch (err) {
      console.warn(`[MultiServerManager] probeServer failed for '${serverId}':`, err?.message || err);
      return false;
    }
  }

  updateStatus(serverId, status, errorMessage = null) {
    const entry = this.servers.get(serverId);
    if (!entry) return;
    entry.status = status;
    entry.errorMessage = errorMessage;
    if (status === 'connected') {
      entry.lastConnectedAt = Date.now();
      entry.circuitBreaker.onSuccess();
    }
  }
}
