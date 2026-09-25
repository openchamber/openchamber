import { describe, expect, test } from 'bun:test';
import { fetchStartupDiagnostics, getInitRecoveryDescriptionKey } from './startupDiagnostics';

describe('startup diagnostics', () => {
  test('reports a crashed OpenCode process even when OpenChamber health is ok', async () => {
    const controller = new AbortController();
    const result = await fetchStartupDiagnostics(controller.signal, async (path, options) => {
      expect(path).toBe('/health');
      expect(options?.signal).toBe(controller.signal);
      expect(options?.cache).toBe('no-store');
      return Response.json({
        status: 'ok',
        openCodeRunning: false,
        isOpenCodeReady: false,
        lastOpenCodeError: 'OpenCode process exited with code 1.\n\u001b[91m\u001b[1mError: \u001b[0mServeError',
        opencodeBinaryResolved: '/mnt/c/nvm4w/nodejs/opencode',
      });
    });
    expect(result).toEqual({
      error: 'OpenCode process exited with code 1.\nError: ServeError',
      binary: '/mnt/c/nvm4w/nodejs/opencode',
    });
  });

  test('uses the failed launch source binary before a newly resolved binary', async () => {
    const result = await fetchStartupDiagnostics(new AbortController().signal, async () => Response.json({
      isOpenCodeReady: false,
      opencodeBinaryResolved: '/new/opencode',
      lastOpenCodeLaunchDiagnostics: { sourceBinary: '/old/opencode', binary: '/usr/bin/node' },
    }));
    expect(result).toEqual({ error: null, binary: '/old/opencode' });
  });

  test('can report an unavailable process without launch details', async () => {
    expect(await fetchStartupDiagnostics(new AbortController().signal, async () => Response.json({
      openCodeRunning: false,
      lastOpenCodeError: null,
      opencodeBinaryResolved: null,
      lastOpenCodeLaunchDiagnostics: null,
    }))).toEqual({ error: null, binary: null });
  });

  test('does not present a historical error as a current failure after recovery', async () => {
    expect(await fetchStartupDiagnostics(new AbortController().signal, async () => Response.json({
      isOpenCodeReady: true,
      openCodeRunning: true,
      lastOpenCodeError: 'An earlier launch failed',
    }))).toBeNull();
  });

  test('does not infer an OpenCode failure from absent readiness fields', async () => {
    expect(await fetchStartupDiagnostics(new AbortController().signal, async () => Response.json({
      status: 'ok',
    }))).toBeNull();
  });

  test('rejects HTTP errors rather than trusting their response body', async () => {
    await expect(fetchStartupDiagnostics(new AbortController().signal, async () => Response.json({
      isOpenCodeReady: false,
      lastOpenCodeError: 'Untrusted diagnostic',
    }, { status: 401 }))).rejects.toThrow('Startup diagnostics request failed (401)');
  });

  test('rejects malformed health data', async () => {
    await expect(fetchStartupDiagnostics(new AbortController().signal, async () => Response.json({
      isOpenCodeReady: 'false',
    }))).rejects.toThrow();
    await expect(fetchStartupDiagnostics(new AbortController().signal, async () => new Response('not JSON')))
      .rejects.toThrow();
  });

  test('propagates transport failures and request cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchStartupDiagnostics(controller.signal, async (_path, options) => {
      options?.signal?.throwIfAborted();
      return Response.json({ isOpenCodeReady: false });
    })).rejects.toThrow();
    await expect(fetchStartupDiagnostics(new AbortController().signal, async () => {
      throw new Error('Server unreachable');
    })).rejects.toThrow('Server unreachable');
  });

  test('asks to check the server only when it could not be reached', () => {
    expect(getInitRecoveryDescriptionKey(null, { step: 'serverUnreachable', message: null }))
      .toBe('startup.initRecovery.serverUnreachable');
    expect(getInitRecoveryDescriptionKey(null, { step: 'loadAgents', message: 'boom' }))
      .toBe('startup.initRecovery.loadAgentsFailed');
    expect(getInitRecoveryDescriptionKey(null, { step: 'openCodeUnavailable', message: null }))
      .toBe('startup.initRecovery.openCodeUnavailable');
    expect(getInitRecoveryDescriptionKey(null, { step: 'unexpected', message: 'boom' }))
      .toBe('startup.initRecovery.unexpected');
    expect(getInitRecoveryDescriptionKey(null, null)).toBe('startup.initRecovery.unexpected');
  });

  test('server diagnostics win over the client-side failure guess', () => {
    expect(getInitRecoveryDescriptionKey({ error: 'crash', binary: null }, { step: 'serverUnreachable', message: null }))
      .toBe('startup.initRecovery.openCodeUnavailable');
  });
});
