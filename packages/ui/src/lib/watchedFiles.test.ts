import { afterEach, describe, expect, test } from 'bun:test';

import { opencodeClient } from '@/lib/opencode/client';
import { notifyWatchedFileChanged, renewWatchedFiles, watchFileOnScreen } from './watchedFiles';

const originalWatchFile = opencodeClient.watchFile;
const stops: Array<() => void> = [];
let requests: Array<[string, string]> = [];

const answerWatches = (accept: boolean) => {
  requests = [];
  opencodeClient.watchFile = async (directory: string, relativePath: string) => {
    requests.push([directory, relativePath]);
    if (!accept) throw new Error('disabled');
  };
};

afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
  opencodeClient.watchFile = originalWatchFile;
});

describe('watched files', () => {
  test('asks OpenCode to watch a file by its path in the location and reports its changes', async () => {
    answerWatches(true);
    let changes = 0;
    const watch = watchFileOnScreen('/repo', '/repo/src/a.ts', () => { changes += 1; });
    stops.push(watch.stop);

    expect(await watch.watching).toBe(true);
    expect(requests).toEqual([['/repo', 'src/a.ts']]);
    notifyWatchedFileChanged('/repo/src/a.ts');
    notifyWatchedFileChanged('/repo/src/b.ts');
    expect(changes).toBe(1);

    watch.stop();
    notifyWatchedFileChanged('/repo/src/a.ts');
    expect(changes).toBe(1);
  });

  test('does not watch a file outside the location, and reports a refused watch', async () => {
    answerWatches(false);
    const outside = watchFileOnScreen('/repo', '/elsewhere/plan.md', () => {});
    expect(await outside.watching).toBe(false);
    expect(requests).toEqual([]);

    const refused = watchFileOnScreen('/repo', '/repo/a.ts', () => {});
    stops.push(refused.stop);
    expect(await refused.watching).toBe(false);
  });

  test('a reconnect asks again and has each view check its file once', async () => {
    answerWatches(true);
    let changes = 0;
    const watch = watchFileOnScreen('/repo', '/repo/a.ts', () => { changes += 1; });
    stops.push(watch.stop);
    await watch.watching;

    renewWatchedFiles();
    expect(requests).toHaveLength(2);
    expect(changes).toBe(1);
  });
});
