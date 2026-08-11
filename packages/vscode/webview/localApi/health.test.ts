import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleHealthRoutes } from './routes/health';

type ConnectionValue = {
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  cliAvailable?: boolean;
};

const setConnection = (value: ConnectionValue) => {
  const root = globalThis as typeof globalThis & {
    window?: { __OPENCHAMBER_CONNECTION__?: ConnectionValue };
  };
  if (!root.window || typeof root.window !== 'object') {
    Object.defineProperty(root, 'window', {
      value: {},
      writable: true,
      configurable: true,
    });
  }
  root.window!.__OPENCHAMBER_CONNECTION__ = value;
};

describe('handleHealthRoutes', () => {
  beforeEach(() => {
    setConnection({ status: 'connecting', cliAvailable: true });
  });

  it('includes openCodeRunning when connected', async () => {
    setConnection({ status: 'connected', cliAvailable: true });

    const response = await handleHealthRoutes({
      input: '/health',
      url: new URL('https://localhost/health'),
      init: undefined,
      method: 'GET',
      pathname: '/health',
      normalizedPathname: '/health',
    });

    assert.ok(response);
    const body = await response!.json() as {
      isOpenCodeReady: boolean;
      openCodeRunning: boolean;
      cliAvailable: boolean;
    };
    assert.equal(body.isOpenCodeReady, true);
    assert.equal(body.openCodeRunning, true);
    assert.equal(body.cliAvailable, true);
  });

  it('reports connecting when not connected', async () => {
    setConnection({ status: 'connecting', cliAvailable: false });

    const response = await handleHealthRoutes({
      input: '/health',
      url: new URL('https://localhost/health'),
      init: undefined,
      method: 'GET',
      pathname: '/health',
      normalizedPathname: '/health',
    });

    assert.ok(response);
    const body = await response!.json() as {
      status: string;
      openCodeRunning: boolean;
      cliAvailable: boolean;
    };
    assert.equal(body.status, 'connecting');
    assert.equal(body.openCodeRunning, false);
    assert.equal(body.cliAvailable, false);
  });
});
