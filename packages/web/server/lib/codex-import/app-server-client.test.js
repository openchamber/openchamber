import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createCodexAppServerClient } from './app-server-client.js';

describe('Codex app-server client', () => {
  it('does not expose app-server stderr when the process exits', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.stdin = {
      destroyed: false,
      write: vi.fn((line) => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`));
        }
      }),
    };
    const client = createCodexAppServerClient({ spawn: vi.fn(() => child) });
    await client.start();

    const request = client.request('thread/list');
    child.stderr.write('token=must-not-leak');
    child.emit('exit', 1, null);

    await expect(request).rejects.toThrow('Codex app-server exited (1)');
    await expect(request).rejects.not.toThrow('must-not-leak');
    client.close();
  });
});
