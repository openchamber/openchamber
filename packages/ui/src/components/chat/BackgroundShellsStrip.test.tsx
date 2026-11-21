import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import type { RunningShell } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import type { SyncEvent } from '@/lib/opencode/events';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyBackgroundShellEvents, resetBackgroundShells } from '@/sync/background-shells';
import { applyBackgroundImageEvents, resetBackgroundImages } from '@/sync/background-images';
import { BackgroundShellsStrip } from './BackgroundShellsStrip';
import { stopForegroundShell } from './message/parts/foregroundShellStop';

const session = (id: string, parentID?: string): Session => ({
  id, parentID, projectID: 'project', directory: '/repo', title: id, cost: 0,
  time: { created: 1, updated: 1 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const shell = (id: string, sessionID: string, command: string, startedAt = Date.now()): RunningShell => ({
  id, sessionID, command, file: `/tmp/${id}.out`, startedAt,
});

const startEvent = (value: RunningShell): SyncEvent => ({ type: 'shell.started', properties: { shell: value } });

/** Starts commands whose calls went to the background. */
const start = (...shells: RunningShell[]) => act(async () => {
  applyBackgroundShellEvents('/repo', shells.flatMap((value): SyncEvent[] => [
    startEvent(value),
    {
      type: 'message.tool.transition',
      properties: {
        sessionID: value.sessionID,
        messageID: 'msg_1',
        partID: `call_${value.id}`,
        transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: value.id }, executed: true, end: value.startedAt },
      },
    },
  ]));
});

/** An image job the session started, as its `image_generate` call settles. */
const startImage = (jobID: string, sessionID: string, path: string) => act(async () => {
  applyBackgroundImageEvents('/repo', [{
    type: 'message.tool.transition',
    properties: {
      sessionID,
      messageID: 'msg_1',
      partID: `call_${jobID}`,
      transition: { kind: 'success', output: '', metadata: { jobID, path, model: 'openai/gpt-image-2' }, executed: true, end: Date.now() - 5_000 },
    },
  }]);
});

describe('BackgroundShellsStrip', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    resetBackgroundShells();
    resetBackgroundImages();
    useGlobalSessionsStore.setState({
      entityById: new Map([
        ['ses_root', session('ses_root')],
        ['ses_child', session('ses_child', 'ses_root')],
        ['ses_other', session('ses_other')],
      ]),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <I18nProvider>
          <BackgroundShellsStrip sessionId="ses_root" directory="/repo" />
        </I18nProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
    resetBackgroundShells();
    resetBackgroundImages();
  });

  const buttons = () => [...host.querySelectorAll('button')];
  const button = (label: string) => buttons().find((item) => item.textContent === label || item.getAttribute('aria-label') === label);

  test('renders nothing while no command of the session runs', async () => {
    await start(shell('sh_other', 'ses_other', 'bun run dev'));
    expect(host.innerHTML).toBe('');
  });

  test('a command the turn is still waiting for stays out', async () => {
    await act(async () => {
      applyBackgroundShellEvents('/repo', [startEvent(shell('sh_waited', 'ses_root', 'bun run type-check'))]);
    });
    expect(host.innerHTML).toBe('');
  });

  test('one command is its own row with a stop action', async () => {
    await start(shell('sh_1', 'ses_root', 'bun run dev --port 5391', Date.now() - 65_000));
    expect(host.textContent).toContain('bun run dev --port 5391');
    expect(host.textContent).toContain('1m 5s');
    expect(button('Stop')).toBeDefined();
  });

  test('several commands collapse into a count that expands in place', async () => {
    await start(shell('sh_1', 'ses_root', 'bun run dev'), shell('sh_2', 'ses_child', 'python -m http.server'));
    expect(host.textContent).toContain('Background commands: 2');
    expect(host.textContent).not.toContain('bun run dev');

    const header = buttons().find((item) => item.textContent === 'Background commands: 2');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => header?.click());
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('bun run dev');
    expect(host.textContent).toContain('python -m http.server');
    expect(host.textContent).toContain('subagent');
    expect(buttons().filter((item) => item.textContent === 'Stop')).toHaveLength(2);
  });

  test('stop goes through the shared stop flow, addressed to the session that owns the command', async () => {
    const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockResolvedValue(undefined);
    try {
      await start(shell('sh_child', 'ses_child', 'vite preview'));
      await act(async () => button('Stop')?.click());
      expect(stop.mock.calls).toEqual([[{
        sessionID: 'ses_child',
        sessionDirectory: '/repo',
        shells: [{ shellID: 'sh_child', shellDirectory: '/repo', command: 'vite preview' }],
      }]]);
      expect(button('Stop')?.disabled).toBe(true);

      // The row leaves when OpenCode reports the end.
      await act(async () => {
        applyBackgroundShellEvents('/repo', [{ type: 'shell.ended', properties: { shellID: 'sh_child', end: { kind: 'removed' }, endedAt: 2000 } }]);
      });
      expect(host.innerHTML).toBe('');
    } finally {
      stop.mockRestore();
    }
  });

  test('stop all stops every command with one call per owning session', async () => {
    const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockResolvedValue(undefined);
    try {
      await start(
        shell('sh_1', 'ses_root', 'bun run dev'),
        shell('sh_2', 'ses_root', 'bun run watch'),
        shell('sh_3', 'ses_child', 'vite preview'),
      );
      expect(button('Stop')).toBeUndefined();
      await act(async () => button('Stop all')?.click());
      expect(stop.mock.calls).toEqual([
        [{
          sessionID: 'ses_root',
          sessionDirectory: '/repo',
          shells: [
            { shellID: 'sh_1', shellDirectory: '/repo', command: 'bun run dev' },
            { shellID: 'sh_2', shellDirectory: '/repo', command: 'bun run watch' },
          ],
        }],
        [{
          sessionID: 'ses_child',
          sessionDirectory: '/repo',
          shells: [{ shellID: 'sh_3', shellDirectory: '/repo', command: 'vite preview' }],
        }],
      ]);
      expect(button('Stop all')?.disabled).toBe(true);
    } finally {
      stop.mockRestore();
    }
  });

  test('a command its chat row is stopping offers no second stop here', async () => {
    const waited = shell('sh_waited', 'ses_root', 'bun run test');
    // The row's stop moved the call to the background and is still on its way.
    const background = spyOn(opencodeClient, 'backgroundSessionWork').mockImplementation(() => {
      applyBackgroundShellEvents('/repo', [{
        type: 'message.tool.transition',
        properties: {
          sessionID: 'ses_root', messageID: 'msg_1', partID: 'call_sh_waited',
          transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: 'sh_waited' }, executed: true, end: 2 },
        },
      }]);
      return new Promise<void>(() => {});
    });
    const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockResolvedValue(undefined);
    try {
      await act(async () => { applyBackgroundShellEvents('/repo', [startEvent(waited)]); });
      await act(async () => { void stopForegroundShell({ sessionID: 'ses_root', sessionDirectory: '/repo', shell: { shellID: 'sh_waited', shellDirectory: '/repo', command: 'bun run test' } }); });
      expect(button('Stop')?.disabled).toBe(true);

      await start(shell('sh_dev', 'ses_root', 'bun run dev'));
      await act(async () => button('Stop all')?.click());
      expect(stop.mock.calls).toEqual([[{
        sessionID: 'ses_root',
        sessionDirectory: '/repo',
        shells: [{ shellID: 'sh_dev', shellDirectory: '/repo', command: 'bun run dev' }],
      }]]);
    } finally {
      background.mockRestore();
      stop.mockRestore();
    }
  });

  test('stop all is off while chat rows stop every listed command, and back after one of those stops fails', async () => {
    const waited = [shell('sh_fg_1', 'ses_root', 'bun run test'), shell('sh_fg_2', 'ses_root', 'bun run e2e')];
    const rejects: Array<(error: Error) => void> = [];
    // Backgrounding moves both calls to the background, then stays pending
    // until the test fails it.
    const background = spyOn(opencodeClient, 'backgroundSessionWork').mockImplementation(() => {
      applyBackgroundShellEvents('/repo', waited.map((value): SyncEvent => ({
        type: 'message.tool.transition',
        properties: {
          sessionID: 'ses_root', messageID: 'msg_1', partID: `call_${value.id}`,
          transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: value.id }, executed: true, end: 2 },
        },
      })));
      return new Promise<void>((_resolve, reject) => { rejects.push(reject); });
    });
    const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockResolvedValue(undefined);
    try {
      await act(async () => { applyBackgroundShellEvents('/repo', waited.map(startEvent)); });
      const stops = waited.map((value) => stopForegroundShell({
        sessionID: 'ses_root',
        sessionDirectory: '/repo',
        shell: { shellID: value.id, shellDirectory: '/repo', command: value.command },
      }).catch(() => undefined));
      await act(async () => {});
      expect(button('Stop all')?.disabled).toBe(true);

      await act(async () => {
        rejects[0]?.(new Error('offline'));
        await stops[0];
      });
      expect(button('Stop all')?.disabled).toBe(false);
      await act(async () => button('Stop all')?.click());
      expect(stop.mock.calls).toEqual([[{
        sessionID: 'ses_root',
        sessionDirectory: '/repo',
        shells: [{ shellID: 'sh_fg_1', shellDirectory: '/repo', command: 'bun run test' }],
      }]]);
    } finally {
      rejects.forEach((reject) => reject(new Error('done')));
      background.mockRestore();
      stop.mockRestore();
    }
  });

  test('a failed stop makes its commands stoppable again', async () => {
    const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockRejectedValue(new Error('offline'));
    try {
      await start(shell('sh_1', 'ses_root', 'bun run dev'), shell('sh_2', 'ses_root', 'bun run watch'));
      await act(async () => button('Stop all')?.click());
      expect(stop.mock.calls).toHaveLength(1);
      expect(button('Stop all')?.disabled).toBe(false);
    } finally {
      stop.mockRestore();
    }
  });

  test('an image the session generates is its own row, without a stop', async () => {
    await startImage('image_1', 'ses_root', '/repo/assets/hero');
    expect(host.textContent).toContain('Generating an image');
    expect(host.textContent).toContain('hero');
    expect(button('Stop')).toBeUndefined();
  });

  test('a command and an image of a subagent collapse into one count; Stop all stops the command only', async () => {
    const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockResolvedValue(undefined);
    await start(shell('sh_1', 'ses_root', 'bun run dev'));
    await startImage('image_1', 'ses_child', '/tmp/images/image_1');
    expect(host.textContent).toContain('In the background: 2');

    await act(async () => button('Stop all')?.click());
    expect(stop.mock.calls.map(([input]) => input.shells.map((item) => item.shellID))).toEqual([['sh_1']]);
    stop.mockRestore();
  });
});
