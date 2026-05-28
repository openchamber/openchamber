import { describe, expect, mock, test } from 'bun:test';
import { CircuitBreaker, MultiServerManager } from './multi-server-manager.js';

describe('CircuitBreaker', () => {
  test('3 consecutive failures opens circuit', () => {
    const cb = new CircuitBreaker();
    expect(cb.shouldSkip()).toBe(false);
    cb.onFailure();
    expect(cb.shouldSkip()).toBe(false);
    cb.onFailure();
    expect(cb.shouldSkip()).toBe(false);
    cb.onFailure();
    expect(cb.shouldSkip()).toBe(true);
  });

  test('shouldSkip returns true when open', () => {
    const cb = new CircuitBreaker();
    cb.consecutiveFailures = 3;
    cb.circuitOpen = true;
    cb.nextRetryAt = Date.now() + 10000;
    expect(cb.shouldSkip()).toBe(true);
  });

  test('half-open after timeout expires', () => {
    const cb = new CircuitBreaker();
    cb.consecutiveFailures = 3;
    cb.circuitOpen = true;
    cb.nextRetryAt = Date.now() - 1;
    expect(cb.shouldSkip()).toBe(false);
    expect(cb.circuitOpen).toBe(false);
  });

  test('success resets failures', () => {
    const cb = new CircuitBreaker();
    cb.consecutiveFailures = 5;
    cb.circuitOpen = true;
    cb.nextRetryAt = Date.now() + 10000;
    cb.onSuccess();
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.circuitOpen).toBe(false);
  });
});

describe('MultiServerManager', () => {
  test('registerServer creates new entry', () => {
    const mgr = new MultiServerManager();
    const entry = mgr.registerServer({ id: 's1', label: 'Server 1', type: 'remote-url', url: 'http://example.com' });
    expect(entry.id).toBe('s1');
    expect(entry.label).toBe('Server 1');
    expect(entry.type).toBe('remote-url');
    expect(entry.refCount).toBe(1);
    expect(entry.status).toBe('connecting');
    expect(mgr.servers.size).toBe(1);
  });

  test('registerServer defaults type to local', () => {
    const mgr = new MultiServerManager();
    const entry = mgr.registerServer({ id: 'main', label: 'Main' });
    expect(entry.type).toBe('local');
  });

  test('registerServer increments refCount for existing connected', () => {
    const mgr = new MultiServerManager();
    mgr.registerServer({ id: 's1', label: 'S1' });
    mgr.updateStatus('s1', 'connected');
    const entry = mgr.registerServer({ id: 's1', label: 'S1' });
    expect(entry.refCount).toBe(2);
    expect(entry.status).toBe('connected');
  });

  test('registerServer replaces client for disconnected', () => {
    const mgr = new MultiServerManager();
    const oldClient = {};
    mgr.registerServer({ id: 's1', label: 'S1', client: oldClient });
    mgr.updateStatus('s1', 'disconnected');

    const newClient = {};
    const entry = mgr.registerServer({ id: 's1', label: 'S1', client: newClient });
    expect(entry.client).toBe(newClient);
    expect(entry.status).toBe('connecting');
    expect(entry.errorMessage).toBeNull();
  });

  test('registerServer calls disconnect on old client when reconnecting disconnected', () => {
    const mgr = new MultiServerManager();
    const disconnectFn = mock();
    const oldClient = { disconnect: disconnectFn };
    mgr.registerServer({ id: 's1', label: 'S1', client: oldClient });
    mgr.updateStatus('s1', 'disconnected');

    mgr.registerServer({ id: 's1', label: 'S1', client: {} });
    expect(disconnectFn).toHaveBeenCalled();
  });

  test('registerServer replaces client for error state', () => {
    const mgr = new MultiServerManager();
    const oldClient = {};
    mgr.registerServer({ id: 's1', label: 'S1', client: oldClient });
    mgr.updateStatus('s1', 'error', 'some error');

    const newClient = {};
    const entry = mgr.registerServer({ id: 's1', label: 'S1', client: newClient });
    expect(entry.client).toBe(newClient);
    expect(entry.status).toBe('connecting');
    expect(entry.errorMessage).toBeNull();
  });

  test('registerServer calls disconnect on old client when reconnecting from error', () => {
    const mgr = new MultiServerManager();
    const disconnectFn = mock();
    const oldClient = { disconnect: disconnectFn };
    mgr.registerServer({ id: 's1', label: 'S1', client: oldClient });
    mgr.updateStatus('s1', 'error');

    mgr.registerServer({ id: 's1', label: 'S1', client: {} });
    expect(disconnectFn).toHaveBeenCalled();
  });

  test('removeServer decrements refCount', () => {
    const mgr = new MultiServerManager();
    mgr.registerServer({ id: 's1', label: 'S1' });
    mgr.registerServer({ id: 's1', label: 'S1' });
    expect(mgr.servers.get('s1').refCount).toBe(2);

    mgr.removeServer('s1');
    expect(mgr.servers.get('s1').refCount).toBe(1);
    expect(mgr.servers.has('s1')).toBe(true);
  });

  test('removeServer cleans up when refCount <= 0', () => {
    const mgr = new MultiServerManager();
    const disconnectFn = mock();
    mgr.registerServer({ id: 's1', label: 'S1', client: { disconnect: disconnectFn } });

    mgr.removeServer('s1');
    expect(disconnectFn).toHaveBeenCalled();
    expect(mgr.servers.has('s1')).toBe(false);
  });

  test('removeServer throws for local', () => {
    const mgr = new MultiServerManager();
    mgr.registerServer({ id: 'local', label: 'Local', type: 'local' });

    expect(() => mgr.removeServer('local')).toThrow('Cannot remove local server');
  });

  test('listServers returns correct shape', () => {
    const mgr = new MultiServerManager();
    mgr.registerServer({ id: 's1', label: 'S1', type: 'remote-url', url: 'http://a.com' });
    mgr.updateStatus('s1', 'error', 'timeout');

    const list = mgr.listServers();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: 's1',
      label: 'S1',
      type: 'remote-url',
      status: 'error',
      url: 'http://a.com',
      error: 'timeout',
    });
  });

  test('getClient returns null for non-existent', () => {
    const mgr = new MultiServerManager();
    expect(mgr.getClient('nope')).toBeNull();
  });

  test('updateStatus sets connected and resets circuitBreaker', () => {
    const mgr = new MultiServerManager();
    const entry = mgr.registerServer({ id: 's1', label: 'S1' });
    entry.circuitBreaker.consecutiveFailures = 5;
    entry.circuitBreaker.circuitOpen = true;

    mgr.updateStatus('s1', 'connected');
    expect(entry.status).toBe('connected');
    expect(entry.lastConnectedAt).toBeGreaterThan(0);
    expect(entry.circuitBreaker.consecutiveFailures).toBe(0);
    expect(entry.circuitBreaker.circuitOpen).toBe(false);
  });

  test('updateStatus sets error and triggers circuitBreaker onFailure', () => {
    const mgr = new MultiServerManager();
    const entry = mgr.registerServer({ id: 's1', label: 'S1' });

    mgr.updateStatus('s1', 'error', 'connection refused');
    expect(entry.status).toBe('error');
    expect(entry.errorMessage).toBe('connection refused');
    expect(entry.circuitBreaker.consecutiveFailures).toBe(1);
  });

  test('updateStatus is no-op for non-existent server', () => {
    const mgr = new MultiServerManager();
    expect(() => mgr.updateStatus('nope', 'connected')).not.toThrow();
  });

  test('getGlobalSessions skips circuitOpen servers', async () => {
    const mgr = new MultiServerManager();
    const healthyList = mock(async () => [{ id: 'sess1' }]);
    const skippedList = mock(async () => [{ id: 'sess2' }]);

    const entry1 = mgr.registerServer({ id: 's1', label: 'S1', client: { session: { list: healthyList } } });
    mgr.updateStatus('s1', 'connected');

    const entry2 = mgr.registerServer({ id: 's2', label: 'S2', client: { session: { list: skippedList } } });
    entry2.circuitBreaker.consecutiveFailures = 3;
    entry2.circuitBreaker.circuitOpen = true;
    entry2.circuitBreaker.nextRetryAt = Date.now() + 60000;

    const result = await mgr.getGlobalSessions();
    expect(result.sessions).toEqual([{ id: 'sess1', serverId: 's1' }]);
    expect(result.errors).toEqual([]);
    expect(healthyList).toHaveBeenCalledTimes(1);
    expect(skippedList).not.toHaveBeenCalled();
  });

  test('getGlobalSessions handles errors and tracks failures in circuitBreaker', async () => {
    const mgr = new MultiServerManager();
    const entry = mgr.registerServer({
      id: 's1',
      label: 'S1',
      client: { session: { list: mock(async () => { throw new Error('network error'); }) } },
    });
    mgr.updateStatus('s1', 'connected');

    const result = await mgr.getGlobalSessions();
    expect(result.sessions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({ serverId: 's1', error: 'network error' });
    expect(entry.circuitBreaker.consecutiveFailures).toBe(1);
  });

  test('getGlobalSessions skips servers without session.list', async () => {
    const mgr = new MultiServerManager();
    mgr.registerServer({ id: 's1', label: 'S1', client: {} });
    mgr.updateStatus('s1', 'connected');

    const result = await mgr.getGlobalSessions();
    expect(result.sessions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].serverId).toBe('s1');
  });

  test('getGlobalSessions passes archived option', async () => {
    const mgr = new MultiServerManager();
    const listFn = mock(async () => []);
    mgr.registerServer({ id: 's1', label: 'S1', client: { session: { list: listFn } } });
    mgr.updateStatus('s1', 'connected');

    await mgr.getGlobalSessions({ archived: true });
    expect(listFn).toHaveBeenCalledWith({ archived: true });
  });

  test('getServer returns server entry or null', () => {
    const mgr = new MultiServerManager();
    expect(mgr.getServer('missing')).toBeNull();
    mgr.registerServer({ id: 's1', label: 'S1' });
    expect(mgr.getServer('s1')).not.toBeNull();
    expect(mgr.getServer('s1').id).toBe('s1');
  });

  test('setDefaultServer and getDefaultServerId', () => {
    const mgr = new MultiServerManager();
    expect(mgr.getDefaultServerId()).toBe('local');
    mgr.setDefaultServer('s1');
    expect(mgr.getDefaultServerId()).toBe('s1');
  });

  test('probeServer returns false for non-existent server', async () => {
    const mgr = new MultiServerManager();
    expect(await mgr.probeServer('nope')).toBe(false);
  });

  test('probeServer returns false when no health client', async () => {
    const mgr = new MultiServerManager();
    mgr.registerServer({ id: 's1', label: 'S1', client: {} });
    expect(await mgr.probeServer('s1')).toBe(false);
  });

  test('probeServer returns true on successful health check', async () => {
    const mgr = new MultiServerManager();
    mgr.registerServer({
      id: 's1',
      label: 'S1',
      client: { health: { check: mock(async () => true) } },
    });
    expect(await mgr.probeServer('s1')).toBe(true);
  });

  test('probeServer returns false on failed health check', async () => {
    const mgr = new MultiServerManager();
    mgr.registerServer({
      id: 's1',
      label: 'S1',
      client: { health: { check: mock(async () => { throw new Error('fail'); }) } },
    });
    expect(await mgr.probeServer('s1')).toBe(false);
  });
});
