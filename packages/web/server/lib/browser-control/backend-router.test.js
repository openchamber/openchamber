import { describe, expect, it, vi } from 'vitest';

import { BrowserControlError } from './broker.js';
import { createBrowserBackendRouter } from './backend-router.js';

const CHROME_MISSING_MESSAGE = 'Chrome or Chromium was not found. Set OPENCHAMBER_CHROME_PATH to an executable Chrome or Chromium binary.';

const createRouter = ({ enabled = false, servingClient = false, brokerRequest, backend, loadBackend } = {}) => {
  const request = brokerRequest ?? vi.fn(async () => ({ served: 'client' }));
  const serverBackend = backend ?? {
    execute: vi.fn(async () => ({ served: 'server' })),
    listTabs: vi.fn(async () => []),
    getSession: vi.fn(() => null),
  };
  const getServerBackend = vi.fn(loadBackend ?? (async () => serverBackend));
  const hasServingClient = vi.fn(() => servingClient);
  const router = createBrowserBackendRouter({
    broker: { request },
    isServerBackendEnabled: () => enabled,
    getServerBackend,
    hasServingClient,
  });
  return { router, brokerRequest: request, serverBackend, getServerBackend, hasServingClient };
};

const noClientError = (message = 'No connected OpenChamber window can serve the browser panel for /repo. Nothing was changed.') => {
  const error = new BrowserControlError(message, 503);
  error.code = 'no-client';
  return error;
};

describe('browser backend router', () => {
  it('requires its injected dependencies', () => {
    expect(() => createBrowserBackendRouter({})).toThrow(TypeError);
  });

  describe('caller cancellation', () => {
    it('passes the captured signal to the server backend', async () => {
      const { router, serverBackend } = createRouter({ enabled: true });
      const signal = new AbortController().signal;
      const target = { directory: '/repo' };

      await router.request('browser.open', { url: 'http://a/' }, { target, signal });

      expect(serverBackend.execute).toHaveBeenCalledWith(target, 'browser.open', { url: 'http://a/' }, { signal });
    });

    it('does not load the server for an already cancelled request', async () => {
      const { router, getServerBackend } = createRouter({ enabled: true });
      const controller = new AbortController();
      controller.abort();

      await expect(router.request('browser.open', { url: 'http://a/' }, {
        target: { directory: '/repo' }, signal: controller.signal,
      })).rejects.toMatchObject({ status: 499 });
      expect(getServerBackend).not.toHaveBeenCalled();
    });

    it('stops before execute when cancelled during lazy backend composition', async () => {
      const loaded = Promise.withResolvers();
      const backend = { execute: vi.fn(), listTabs: vi.fn() };
      const { router } = createRouter({ enabled: true, loadBackend: () => loaded.promise });
      const controller = new AbortController();
      const request = router.request('browser.open', { url: 'http://a/' }, {
        target: { directory: '/repo' }, signal: controller.signal,
      });
      const result = expect(request).rejects.toMatchObject({ status: 499 });
      controller.abort();
      loaded.resolve(backend);

      await result;
      expect(backend.execute).not.toHaveBeenCalled();
    });

    it('captures caller parameters and target before lazy backend composition', async () => {
      const loaded = Promise.withResolvers();
      const backend = { execute: vi.fn(async () => ({})), listTabs: vi.fn() };
      const { router } = createRouter({ enabled: true, loadBackend: () => loaded.promise });
      const target = { directory: '/repo', openCodeSessionId: 'agent-a' };
      const parameters = { url: 'http://a/' };
      const request = router.request('browser.open', parameters, { target });
      target.directory = '/other';
      parameters.url = 'http://b/';
      loaded.resolve(backend);

      await request;
      expect(backend.execute).toHaveBeenCalledWith(
        { directory: '/repo', openCodeSessionId: 'agent-a' }, 'browser.open', { url: 'http://a/' }, { signal: undefined },
      );
    });

    it('does not turn cancellation during tab listing into partial success', async () => {
      const controller = new AbortController();
      const { router, getServerBackend } = createRouter({
        enabled: true,
        brokerRequest: async () => {
          controller.abort();
          throw new BrowserControlError('Browser action was cancelled', 499);
        },
      });

      await expect(router.request('browser.tabs', {}, {
        target: { directory: '/repo' }, signal: controller.signal,
      })).rejects.toMatchObject({ status: 499 });
      expect(getServerBackend).not.toHaveBeenCalled();
    });
  });

  describe('flag off (pre-router behavior, byte-identical)', () => {
    it('passes a tab-less open to the broker verbatim and never touches the server', async () => {
      const { router, brokerRequest, getServerBackend, hasServingClient } = createRouter({ enabled: false });
      const options = { target: { directory: '/repo' }, timeoutMs: 45_000, signal: undefined };

      await router.request('browser.open', { url: 'http://a/' }, options);

      expect(brokerRequest).toHaveBeenCalledWith('browser.open', { url: 'http://a/' }, options);
      expect(getServerBackend).not.toHaveBeenCalled();
      expect(hasServingClient).not.toHaveBeenCalled();
    });

    it('passes an sc:-namespaced tab action to the broker when the feature was never on', async () => {
      const { router, brokerRequest, getServerBackend } = createRouter({ enabled: false });
      const options = { target: { directory: '/repo', tabId: 'sc:ABC' } };

      await router.request('browser.snapshot', {}, options);

      expect(brokerRequest).toHaveBeenCalledWith('browser.snapshot', {}, options);
      expect(getServerBackend).not.toHaveBeenCalled();
    });

    it('passes browser.tabs to the broker alone (no merge)', async () => {
      const { router, brokerRequest, getServerBackend } = createRouter({ enabled: false });
      brokerRequest.mockResolvedValue({ tabs: [{ tabId: 'tab-1', url: 'http://a/', title: 'A', active: true }], target: { directory: '/repo' } });

      const result = await router.request('browser.tabs', {}, {
        target: { directory: '/repo', openCodeSessionId: 'agent-a' },
      });

      expect(result).toEqual({ tabs: [{ tabId: 'tab-1', url: 'http://a/', title: 'A', active: true }], target: { directory: '/repo' } });
      expect(getServerBackend).not.toHaveBeenCalled();
    });
  });

  describe('preferBackend force', () => {
    it('rejects the force with a 503 naming the disabled feature when the flag is off', async () => {
      const { router, brokerRequest, getServerBackend } = createRouter({ enabled: false });
      const target = { directory: '/repo', preferBackend: 'server-chrome' };

      let caught = null;
      try {
        await router.request('browser.snapshot', {}, { target });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BrowserControlError);
      expect(caught.status).toBe(503);
      expect(caught.message).toContain('disabled');
      expect(caught.message).toContain('/repo');
      expect(caught.target).toEqual(target);
      expect(brokerRequest).not.toHaveBeenCalled();
      expect(getServerBackend).not.toHaveBeenCalled();
    });

    it('forces the server path even when a client could serve', async () => {
      const { router, brokerRequest, serverBackend } = createRouter({ enabled: true, servingClient: true });
      const target = { directory: '/repo', preferBackend: 'server-chrome' };

      const result = await router.request('browser.open', { url: 'http://a/' }, { target });

      expect(result).toEqual({ served: 'server' });
      expect(serverBackend.execute).toHaveBeenCalledWith(target, 'browser.open', { url: 'http://a/' }, { signal: undefined });
      expect(brokerRequest).not.toHaveBeenCalled();
    });
  });

  describe('tab-less routing (flag on)', () => {
    it('lets a matching client answer browser.open without consulting the server', async () => {
      const { router, brokerRequest, getServerBackend, hasServingClient } = createRouter({ enabled: true, servingClient: true });
      const target = { directory: '/repo' };

      await router.request('browser.open', { url: 'http://a/' }, { target });

      expect(hasServingClient).toHaveBeenCalledWith('browser.open', target);
      expect(brokerRequest).toHaveBeenCalledTimes(1);
      expect(getServerBackend).not.toHaveBeenCalled();
    });

    it('sends browser.open to the server when no client matches', async () => {
      const { router, brokerRequest, serverBackend } = createRouter({ enabled: true, servingClient: false });
      const target = { directory: '/repo' };

      const result = await router.request('browser.open', { url: 'http://a/' }, { target });

      expect(result).toEqual({ served: 'server' });
      expect(serverBackend.execute).toHaveBeenCalledWith(target, 'browser.open', { url: 'http://a/' }, { signal: undefined });
      expect(brokerRequest).not.toHaveBeenCalled();
    });

    it('sends a tab-less rich action to the broker when a client active target matches', async () => {
      const { router, brokerRequest, getServerBackend, hasServingClient } = createRouter({ enabled: true, servingClient: true });
      const target = { directory: '/repo' };

      await router.request('browser.snapshot', {}, { target });

      expect(hasServingClient).toHaveBeenCalledWith('browser.snapshot', target);
      expect(brokerRequest).toHaveBeenCalledTimes(1);
      expect(getServerBackend).not.toHaveBeenCalled();
    });

    it('sends a tab-less rich action to the server when no client matches', async () => {
      const { router, brokerRequest, serverBackend } = createRouter({ enabled: true, servingClient: false });
      const target = { directory: '/repo' };

      await router.request('browser.click', { selector: 'button' }, { target });

      expect(serverBackend.execute).toHaveBeenCalledWith(target, 'browser.click', { selector: 'button' }, { signal: undefined });
      expect(brokerRequest).not.toHaveBeenCalled();
    });
  });

  describe('tab ownership routing (flag on)', () => {
    it('routes an sc:-namespaced tab to the server regardless of clients', async () => {
      const { router, brokerRequest, serverBackend, hasServingClient } = createRouter({ enabled: true, servingClient: true });
      const target = { directory: '/repo', tabId: 'sc:ABC123' };

      await router.request('browser.snapshot', {}, { target });

      expect(serverBackend.execute).toHaveBeenCalledWith(target, 'browser.snapshot', {}, { signal: undefined });
      expect(brokerRequest).not.toHaveBeenCalled();
      expect(hasServingClient).not.toHaveBeenCalled();
    });

    it('routes a client-owned tab to the broker regardless of the server', async () => {
      const { router, brokerRequest, getServerBackend } = createRouter({ enabled: true, servingClient: false });
      const target = { directory: '/repo', tabId: 'tab-7' };

      await router.request('browser.click', { selector: 'button' }, { target });

      expect(brokerRequest).toHaveBeenCalledTimes(1);
      expect(getServerBackend).not.toHaveBeenCalled();
    });
  });

  describe('browser.tabs merge (flag on)', () => {
    it('returns the union of both backends, every entry tagged with its backend', async () => {
      const brokerRequest = vi.fn(async () => ({
        tabs: [{ tabId: 'tab-1', url: 'http://a/', title: 'A', active: true }],
        target: { directory: '/repo', openCodeSessionId: 'agent-a' },
      }));
      const backend = {
        execute: vi.fn(),
        listTabs: vi.fn(async () => [{ tabId: 'sc:1', url: 'http://b/', title: 'B', active: false, backend: 'server-chrome' }]),
        getSession: vi.fn(() => null),
      };
      const { router } = createRouter({ enabled: true, brokerRequest, backend });

      const result = await router.request('browser.tabs', {}, {
        target: { directory: '/repo', openCodeSessionId: 'agent-a' },
      });

      expect(result).toEqual({
        tabs: [
          { backend: 'electron-webview', tabId: 'tab-1', url: 'http://a/', title: 'A', active: true },
          { tabId: 'sc:1', url: 'http://b/', title: 'B', active: false, backend: 'server-chrome' },
        ],
        target: { directory: '/repo', openCodeSessionId: 'agent-a' },
      });
      expect(brokerRequest).toHaveBeenCalledTimes(1);
      expect(backend.listTabs).toHaveBeenCalledWith({ directory: '/repo', openCodeSessionId: 'agent-a' }, { signal: undefined });
    });

    it('returns the server listing alone when no client is connected, without an error marker', async () => {
      const brokerRequest = vi.fn(async () => { throw noClientError(); });
      const backend = {
        execute: vi.fn(),
        listTabs: vi.fn(async () => [{ tabId: 'sc:1', url: 'http://b/', title: 'B', active: false, backend: 'server-chrome' }]),
        getSession: vi.fn(() => null),
      };
      const { router } = createRouter({ enabled: true, brokerRequest, backend });

      const result = await router.request('browser.tabs', {}, { target: { directory: '/repo' } });

      expect(result.tabs).toEqual([{ tabId: 'sc:1', url: 'http://b/', title: 'B', active: false, backend: 'server-chrome' }]);
      expect(result.clientError).toBeUndefined();
    });

    it('keeps the server listing when the client leg really fails, marking the result partial', async () => {
      const brokerRequest = vi.fn(async () => { throw new BrowserControlError('The client window exploded', 500); });
      const backend = {
        execute: vi.fn(),
        listTabs: vi.fn(async () => [{ tabId: 'sc:1', url: 'http://b/', title: 'B', active: false, backend: 'server-chrome' }]),
        getSession: vi.fn(() => null),
      };
      const { router } = createRouter({ enabled: true, brokerRequest, backend });

      const result = await router.request('browser.tabs', {}, { target: { directory: '/repo' } });

      expect(result.tabs).toHaveLength(1);
      expect(result.clientError).toBe('The client window exploded');
    });

    it('fails with the server reason when no client is connected and the server cannot serve', async () => {
      const brokerRequest = vi.fn(async () => { throw noClientError(); });
      const getServerBackendError = new Error(CHROME_MISSING_MESSAGE);
      const backend = {
        execute: vi.fn(),
        listTabs: vi.fn(async () => { throw getServerBackendError; }),
        getSession: vi.fn(() => null),
      };
      const { router } = createRouter({ enabled: true, brokerRequest, backend });

      let caught = null;
      try {
        await router.request('browser.tabs', {}, { target: { directory: '/repo' } });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BrowserControlError);
      expect(caught.status).toBe(503);
      expect(caught.message).toContain('Chrome or Chromium was not found');
      expect(caught.target).toEqual({ directory: '/repo' });
    });
  });

  describe('server path failures', () => {
    it('escalates a missing Chrome binary to a 503 carrying the actionable text', async () => {
      const backend = {
        execute: vi.fn(async () => { throw new BrowserControlError(CHROME_MISSING_MESSAGE, 400); }),
        listTabs: vi.fn(async () => []),
        getSession: vi.fn(() => null),
      };
      const { router, brokerRequest } = createRouter({ enabled: true, servingClient: false, backend });
      const target = { directory: '/repo' };

      let caught = null;
      try {
        await router.request('browser.open', { url: 'http://a/' }, { target });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BrowserControlError);
      expect(caught.status).toBe(503);
      expect(caught.message).toContain('Chrome or Chromium was not found');
      expect(caught.message).toContain('OPENCHAMBER_CHROME_PATH');
      expect(caught.target).toEqual(target);
      expect(brokerRequest).not.toHaveBeenCalled();
    });

    it('passes a mid-action crash through with its status and target intact', async () => {
      const crash = new BrowserControlError('Browser target sc:ABC: CDP connection closed', 503);
      const backend = {
        execute: vi.fn(async () => { throw crash; }),
        listTabs: vi.fn(async () => []),
        getSession: vi.fn(() => null),
      };
      const { router } = createRouter({ enabled: true, backend });
      const target = { directory: '/repo', tabId: 'sc:ABC' };

      await expect(router.request('browser.snapshot', {}, { target })).rejects.toBe(crash);
      expect(crash.target).toEqual(target);
    });

    it('never lets both backends answer one request', async () => {
      const brokerRequest = vi.fn(async () => { throw new BrowserControlError('client failed', 500); });
      const { router, serverBackend } = createRouter({ enabled: true, servingClient: true, brokerRequest });

      await expect(router.request('browser.click', { selector: 'button' }, { target: { directory: '/repo' } }))
        .rejects.toThrow('client failed');

      expect(brokerRequest).toHaveBeenCalledTimes(1);
      expect(serverBackend.execute).not.toHaveBeenCalled();
    });
  });
});
