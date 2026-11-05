import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import type { SyncEvent } from '@/lib/opencode/events';
import type { Message } from '@/lib/opencode/model';
import { applyReplyCommandEvents, runReplyCommand } from './reply-commands';

const updated = (info: Message): SyncEvent => ({ type: 'message.updated', properties: { info } });
const finished = (state: string) => updated({
  id: 'msg_done', sessionID: 'ses_1', role: 'synthetic', text: 'out', time: { created: 2 },
  metadata: { source: 'shell', shellID: 'sh_1', state },
});

let shellMessageID = '';
let continued = 0;
let finishShell: () => void = () => undefined;
let failShell: (error: Error) => void = () => undefined;

const note = spyOn(opencodeClient, 'addSessionNote');
const shell = spyOn(opencodeClient, 'shellSession');
const resume = spyOn(opencodeClient, 'resumeWithSyntheticInput');

const start = (command: string) => runReplyCommand({ sessionId: 'ses_1', directory: '/repo', replyMessageID: 'msg_reply', command });
const started = (id: string) => updated({ id, sessionID: 'ses_1', role: 'shell', shellID: 'sh_1', command: 'ls', status: 'running', time: { created: 1 } });

beforeEach(() => {
  note.mockResolvedValue(undefined);
  shell.mockImplementation((params) => new Promise<string>((resolve, reject) => {
    shellMessageID = params.messageId ?? '';
    finishShell = () => resolve('');
    failShell = reject;
  }));
  continued = 0;
  resume.mockImplementation(async () => { continued += 1; });
});

afterEach(() => {
  finishShell();
});

describe('runReplyCommand', () => {
  test('continues the agent once the output reached it, once', async () => {
    void start('ls');
    await Promise.resolve();
    await Promise.resolve();
    applyReplyCommandEvents([started(shellMessageID)]);
    expect(continued).toBe(0);
    applyReplyCommandEvents([finished('completed'), finished('completed')]);
    expect(continued).toBe(1);
  });

  test('a stopped command leaves the agent alone', async () => {
    void start('stopped');
    await Promise.resolve();
    await Promise.resolve();
    applyReplyCommandEvents([started(shellMessageID), finished('cancelled')]);
    expect(continued).toBe(0);
  });

  test('rejects when the command did not start', async () => {
    const run = start('broken');
    await Promise.resolve();
    await Promise.resolve();
    failShell(new Error('no shell'));
    await expect(run).rejects.toThrow('no shell');
  });

  test('a request lost after the start is no failure', async () => {
    const run = start('long');
    await Promise.resolve();
    await Promise.resolve();
    applyReplyCommandEvents([started(shellMessageID)]);
    failShell(new Error('connection reset'));
    expect(await run).toBeUndefined();
    applyReplyCommandEvents([finished('completed')]);
    expect(continued).toBe(1);
  });
});
