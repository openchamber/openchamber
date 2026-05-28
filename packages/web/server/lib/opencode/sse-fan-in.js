const DEFAULT_BATCH_INTERVAL = 16;

/**
 * Subscribes to events from multiple Opencode servers, tags each event with
 * its serverId, coalesces high-frequency events by key, and dispatches
 * batches every ~16ms to downstream listeners via onEvent().
 */
export class SseFanIn {
  constructor(serverManager, opts = {}) {
    this.serverManager = serverManager;
    this.subscriptions = new Map();
    this.listeners = new Set();
    this.pending = new Map();
    this.flushTimer = null;
    this.lastEventAt = new Map();
    this.subscribedAt = new Map();
    this.heartbeatTimer = null;
    this.heartbeatIntervalMs = opts.heartbeatMs ?? 120_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
    this.BATCH_INTERVAL = opts.batchInterval ?? DEFAULT_BATCH_INTERVAL;
  }

  startAll() {
    for (const server of this.serverManager.listServers()) {
      if (server.status === 'connecting' || server.status === 'connected') {
        try {
          this.subscribeServer(server.id);
        } catch (err) {
          console.error(`[SseFanIn] Failed to subscribe server '${server.id}':`, err?.message || err);
        }
      }
    }
    this._startHeartbeat();
  }

  subscribeServer(serverId) {
    if (this.subscriptions.has(serverId)) {
      this.unsubscribeServer(serverId);
    }

    const client = this.serverManager.getClient(serverId);
    if (!client) return;

    this.serverManager.updateStatus(serverId, 'connecting');
    this.dispatchSynthetic(serverId, 'server.status', { status: 'connecting' });
    this.subscribedAt.set(serverId, Date.now());

      try {
        const subscription = client.events.subscribe((event) => {
          try {
            this.lastEventAt.set(serverId, Date.now());
            const currentStatus = this.serverManager.getServer(serverId)?.status;
            if (currentStatus !== 'connected') {
              this.serverManager.updateStatus(serverId, 'connected');
              this.dispatchSynthetic(serverId, 'server.status', { status: 'connected' });
            }
            this.onServerEvent(serverId, event);
          } catch (err) {
            console.error(`[SseFanIn] Error processing event for '${serverId}':`, err?.message || err);
          }
        });

      this.subscriptions.set(serverId, subscription);
    } catch (err) {
      console.error(`[SseFanIn] subscribeServer failed for '${serverId}':`, err?.message || err);
      this.subscribedAt.delete(serverId);
      this.lastEventAt.delete(serverId);
      this.serverManager.updateStatus(serverId, 'error', err?.message || 'subscription failed');
      this.dispatchSynthetic(serverId, 'server.status', { status: 'error', errorMessage: err?.message || 'subscription failed' });
    }
  }

  unsubscribeServer(serverId) {
    const sub = this.subscriptions.get(serverId);
    if (sub && typeof sub.unsubscribe === 'function') {
      try { sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.subscriptions.delete(serverId);
    this.lastEventAt.delete(serverId);
    this.subscribedAt.delete(serverId);
    this._clearPending(serverId);
    this.serverManager.updateStatus(serverId, 'disconnected');
    this.dispatchSynthetic(serverId, 'server.status', { status: 'disconnected' });
  }

  dispatchSynthetic(serverId, type, payload) {
    this.dispatch([{ serverId, event: { type, ...payload } }]);
  }

  onServerEvent(serverId, rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object') return;
    const key = this._coalesceKey(serverId, rawEvent);
    if (key) {
      this.pending.set(key, { serverId, event: rawEvent });
    } else {
      this.dispatch([{ serverId, event: rawEvent }]);
      return;
    }
    this._scheduleFlush();
  }

  _coalesceKey(serverId, event) {
    const sessionId = event.sessionID || event.session_id ||
      (event.properties && typeof event.properties === 'object' ? (event.properties.sessionID || event.properties.session_id) : null);
    if (event.type === 'session.status' && sessionId) {
      return `${serverId}:status:${sessionId}`;
    }
    if (event.type === 'message.part.delta' && sessionId) {
      const msgId = event.messageID || event.message_id ||
        (event.properties && typeof event.properties === 'object' ? (event.properties.messageID || event.properties.message_id) : null);
      const partId = event.partID || event.part_id ||
        (event.properties && typeof event.properties === 'object' ? (event.properties.partID || event.properties.part_id) : null);
      const field = event.field ||
        (event.properties && typeof event.properties === 'object' ? event.properties.field : null);
      if (msgId && partId) {
        const suffix = field ? `:${field}` : '';
        return `${serverId}:delta:${sessionId}:${msgId}:${partId}${suffix}`;
      }
      return null;
    }
    return null;
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = [...this.pending.values()];
      this.pending.clear();
      this.dispatch(batch);
    }, this.BATCH_INTERVAL);
  }

  dispatch(batch) {
    const tagged = batch.map(({ serverId, event }) => ({
      ...event,
      serverId,
    }));
    for (const fn of this.listeners) {
      try { fn(tagged); } catch (err) { console.error('[SseFanIn] Dispatch listener error:', err?.message || err); }
    }
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Set up the local server to feed events through this fan-in directly.
   *  This is used when the local server pushes events via a callback
   *  instead of a client.events.subscribe mechanism. */
  feedLocal(serverId, rawEvent) {
    this.lastEventAt.set(serverId, Date.now());
    this.onServerEvent(serverId, rawEvent);
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const serverId of this.subscriptions.keys()) {
        const server = this.serverManager.getServer(serverId);
        if (!server) continue;
        const lastAt = this.lastEventAt.get(serverId);
        if (server.status === 'connecting') {
          const startedAt = this.subscribedAt.get(serverId) || 0;
          if (!lastAt && now - startedAt > this.connectTimeoutMs) {
            console.warn(`[SseFanIn] Server '${serverId}' stuck in connecting for ${Math.round((now - startedAt) / 1000)}s, marking error`);
            this.serverManager.updateStatus(serverId, 'error', 'Connection timeout');
            this.dispatchSynthetic(serverId, 'server.status', { status: 'error', errorMessage: 'Connection timeout' });
          }
          continue;
        }
        if (server.status !== 'connected') continue;
        if (lastAt && now - lastAt > this.heartbeatIntervalMs) {
          console.warn(`[SseFanIn] No events from '${serverId}' for ${Math.round((now - lastAt) / 1000)}s, marking disconnected`);
          this.serverManager.updateStatus(serverId, 'disconnected');
          this.dispatchSynthetic(serverId, 'server.status', { status: 'disconnected' });
        }
      }
      for (const server of this.serverManager.listServers()) {
        if (server.status === 'connecting' || server.status === 'connected') {
          if (this.subscriptions.has(server.id)) continue;
          if (!this.serverManager.getClient(server.id)) continue;
          const startedAt = this.subscribedAt.get(server.id);
          if (!startedAt) {
            this.subscribedAt.set(server.id, now);
            continue;
          }
          if (now - startedAt > this.heartbeatIntervalMs) {
            console.warn(`[SseFanIn] Server '${server.id}' has no active subscription for ${Math.round((now - startedAt) / 1000)}s, marking disconnected`);
            this.serverManager.updateStatus(server.id, 'disconnected');
            this.dispatchSynthetic(server.id, 'server.status', { status: 'disconnected' });
          }
        }
      }
    }, 15000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _clearPending(serverId) {
    for (const key of this.pending.keys()) {
      if (key.startsWith(serverId + ':')) {
        this.pending.delete(key);
      }
    }
  }

  destroy() {
    this._stopHeartbeat();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const sub of this.subscriptions.values()) {
      if (typeof sub.unsubscribe === 'function') {
        try { sub.unsubscribe(); } catch { /* ignore */ }
      }
    }
    this.subscriptions.clear();
    this.listeners.clear();
    this.pending.clear();
    this.lastEventAt.clear();
    this.subscribedAt.clear();
  }
}
