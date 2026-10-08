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
import { BackgroundShellsStrip } from './BackgroundShellsStrip';

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
    const stop = spyOn(opencodeClient, 'stopBackgroundShell').mockResolvedValue(undefined);
    try {
      await start(shell('sh_child', 'ses_child', 'vite preview'));
      await act(async () => button('Stop')?.click());
      expect(stop.mock.calls).toEqual([[{
        sessionID: 'ses_child',
        sessionDirectory: '/repo',
        shellID: 'sh_child',
        shellDirectory: '/repo',
        command: 'vite preview',
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
});
