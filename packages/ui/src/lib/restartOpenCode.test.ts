import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { toast } from '@/components/ui';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { restartOpenCodeWithFeedback } from './restartOpenCode';

describe('restartOpenCodeWithFeedback', () => {
  let paths: string[] = [];
  let warnings: unknown[][] = [];
  let spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    paths = [];
    warnings = [];
    spies = [
      spyOn(toast, 'warning').mockImplementation((...args) => {
        warnings.push(args);
        return 'toast';
      }),
      spyOn(console, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  const serve = (opencodeBinarySource: string) => {
    spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
      paths.push(path);
      if (path === '/health') return Response.json({ opencodeBinarySource });
      return Response.json({ success: true, requiresManualRestart: true });
    }));
  };

  test('names the command for a shared service without asking the server to reload', async () => {
    serve('shared-service');

    expect(await restartOpenCodeWithFeedback((key) => key)).toBe(false);

    expect(paths).toEqual(['/health']);
    expect(warnings).toEqual([[
      'settings.openchamber.opencodeCli.restart.sharedServiceCommand',
      { description: 'opencode service restart' },
    ]]);
  });

  test('sends no reload when the instance is switched during the check', async () => {
    let answerHealth: (response: Response) => void = () => {};
    const health = new Promise<Response>((resolve) => { answerHealth = resolve; });
    spies.push(spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
      if (path === '/health') return health;
      paths.push(path);
      return Response.json({ success: true });
    }));
    try {
      const restart = restartOpenCodeWithFeedback((key) => key);
      switchRuntimeEndpoint({ apiBaseUrl: 'http://other.example', runtimeKey: 'other' });
      answerHealth(Response.json({ opencodeBinarySource: 'bundled' }));

      expect(await restart).toBe(false);
      expect(paths).not.toContain('/api/config/reload');
    } finally {
      switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'local' });
    }
  });

  test('keeps the external feedback for a server started outside OpenChamber', async () => {
    serve('external');

    expect(await restartOpenCodeWithFeedback((key) => key)).toBe(false);

    expect(paths).toEqual(['/health', '/api/config/reload']);
    expect(warnings).toEqual([['settings.openchamber.opencodeCli.restart.external']]);
  });
});
