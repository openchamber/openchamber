import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { RunningShell } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import type { SyncEvent } from '@/lib/opencode/events';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { applyBackgroundShellEvents, resetBackgroundShells } from '@/sync/background-shells';
import { stopForegroundShell } from './foregroundShellStop';

const command: RunningShell = { id: 'sh_1', sessionID: 'ses_1', command: 'sleep 300', file: '/tmp/sh_1.out', startedAt: 1000 };
const shell = { shellID: 'sh_1', shellDirectory: '/repo', command: 'sleep 300' };
const params = { sessionID: 'ses_1', sessionDirectory: '/repo', shell };
const started: SyncEvent = { type: 'shell.started', properties: { shell: command } };
const ended: SyncEvent = { type: 'shell.ended', properties: { shellID: 'sh_1', end: { kind: 'exited', status: 'exited', exit: 0 }, endedAt: 5000 } };
// The call settling while its command runs: it went to the background.
const settled: SyncEvent = {
  type: 'message.tool.transition',
  properties: {
    sessionID: 'ses_1', messageID: 'msg_1', partID: 'call_1',
    transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: 'sh_1' }, executed: true, end: 2000 },
  },
};

const calls: string[] = [];
let background = spyOn(opencodeClient, 'backgroundSessionWork');
let stop = spyOn(opencodeClient, 'stopBackgroundShells');

beforeEach(() => {
  resetBackgroundShells();
  applyBackgroundShellEvents('/repo', [started]);
  calls.length = 0;
  background = spyOn(opencodeClient, 'backgroundSessionWork').mockImplementation(async () => {
    calls.push('background');
    applyBackgroundShellEvents('/repo', [settled]);
  });
  stop = spyOn(opencodeClient, 'stopBackgroundShells').mockImplementation(async () => {
    calls.push('stop');
  });
});

afterEach(() => {
  background.mockRestore();
  stop.mockRestore();
});

const failure = (promise: Promise<void>): Promise<string> => promise.then(() => 'resolved', (error: Error) => error.message);

test('moves the work to the background, waits for the call to settle there, then stops the command', async () => {
  await stopForegroundShell(params);
  expect(calls).toEqual(['background', 'stop']);
  expect(background.mock.calls).toEqual([['ses_1', '/repo']]);
  expect(stop.mock.calls).toEqual([[{ sessionID: 'ses_1', sessionDirectory: '/repo', shells: [shell] }]]);
});

test('a settle that arrives before the background call answers still counts', async () => {
  background.mockImplementation(async () => {
    applyBackgroundShellEvents('/repo', [settled]);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await stopForegroundShell(params);
  expect(stop).toHaveBeenCalledTimes(1);
});

test('a failed background call stops nothing', async () => {
  background.mockRejectedValue(new Error('offline'));
  expect(await failure(stopForegroundShell(params))).toBe('offline');
  expect(stop).not.toHaveBeenCalled();
});

test('a command that ends before it settles, or right after, is not stopped', async () => {
  background.mockImplementation(async () => { applyBackgroundShellEvents('/repo', [ended]); });
  await stopForegroundShell(params);

  applyBackgroundShellEvents('/repo', [started]);
  background.mockImplementation(async () => { applyBackgroundShellEvents('/repo', [settled, ended]); });
  await stopForegroundShell(params);
  expect(stop).not.toHaveBeenCalled();
});

test('a call that never settles fails after the timeout, also while the background call hangs, and stops nothing later', async () => {
  let answer: () => void = () => {};
  background.mockImplementation(() => new Promise<void>((resolve) => { answer = resolve; }));
  expect(await failure(stopForegroundShell(params, 5))).toBe('The command did not move to the background in time.');
  answer();
  applyBackgroundShellEvents('/repo', [settled]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(stop).not.toHaveBeenCalled();
});

test('a runtime switch while it waits stops nothing', async () => {
  background.mockImplementation(async () => { resetBackgroundShells(); });
  expect(await failure(stopForegroundShell(params))).toBe('The runtime changed.');

  applyBackgroundShellEvents('/repo', [started]);
  background.mockImplementation(async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://other-runtime.test', runtimeKey: 'other-runtime' });
    applyBackgroundShellEvents('/repo', [settled]);
  });
  expect(await failure(stopForegroundShell(params))).toBe('The runtime changed before the command was stopped.');
  expect(stop).not.toHaveBeenCalled();
});
