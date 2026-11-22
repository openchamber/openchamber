import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode, type PersistentPtyInfo } from '@opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { PersistentTerminalsStrip } from '@/components/chat/PersistentTerminalsStrip';
import { SyncProvider } from '@/sync/sync-context';
import { applyPersistentPtyEvents, persistentPtyRevision, replaceSessionTerminals, resetPersistentPtys, usePersistentPtysStore } from '@/sync/persistent-ptys';
import { AgentTerminalRow } from './AgentTerminalRow';

const DIRECTORY = '/repo';
const SESSION = 'ses_root';

const terminal = (id: string, overrides: Partial<PersistentPtyInfo> = {}): PersistentPtyInfo => ({
  id,
  title: id,
  command: 'sh',
  args: ['-c', `run ${id}`],
  cwd: DIRECTORY,
  status: 'running',
  pid: 1,
  sessionID: SESSION,
  foregroundProcess: null,
  size: { cols: 120, rows: 40 },
  output: { head: 0, tail: 0 },
  ...overrides,
});

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AgentTerminalRow', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  // Bootstrap stays pending; the rows read only the terminal index.
  const sdk = OpenCode.make({ baseUrl: 'http://terminals.test', fetch: () => new Promise<Response>(() => undefined) });
  const spies: Array<{ mockRestore: () => void }> = [];

  /** Renders the row of one terminal, with what OpenCode last said about it. */
  const show = async (info: PersistentPtyInfo) => {
    await act(async () => {
      applyPersistentPtyEvents(DIRECTORY, [{ type: 'persistent-pty.added', properties: { sessionID: SESSION, terminal: terminal(info.id) } }]);
      replaceSessionTerminals(SESSION, DIRECTORY, [info], persistentPtyRevision());
    });
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={DIRECTORY}>
        <I18nProvider><Row id={info.id} /></I18nProvider>
      </SyncProvider>,
    ));
  };
  const Row = ({ id }: { id: string }) => {
    const pty = usePersistentPtysStore((state) => state.byId.get(id));
    return pty ? <AgentTerminalRow pty={pty} /> : null;
  };

  const buttons = () => [...dom.container.querySelectorAll('button')];
  const button = (label: string) => buttons().find((item) => item.textContent === label || item.getAttribute('aria-label') === label);
  /** The status at the end of the row's second line. */
  const status = () => dom.container.querySelector('span.tabular-nums');

  beforeEach(() => {
    dom = installDom();
    root = createRoot(dom.container);
    resetPersistentPtys();
  });

  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    await act(async () => root.unmount());
    dom.restore();
    resetPersistentPtys();
  });

  test('a running terminal offers Stop and reads running', async () => {
    await show(terminal('pty_1'));
    expect(button('Stop')).toBeDefined();
    expect(status()?.textContent).toBe('running');
  });

  test('an exited terminal offers no Stop and shows its exit code, 0 in the success colour and any other in the error colour', async () => {
    await show(terminal('pty_ok', { status: 'exited', exitCode: 0 }));
    expect(button('Stop')).toBeUndefined();
    expect(status()?.textContent).toBe('exit code 0');
    expect(status()?.className).toContain('text-status-success');
    expect(button('Dismiss sh -c run pty_ok')).toBeDefined();

    await act(async () => root.render(null));
    await show(terminal('pty_failed', { status: 'exited', exitCode: 127 }));
    expect(status()?.textContent).toBe('exit code 127');
    expect(status()?.className).toContain('text-status-error');
  });

  test('an exit OpenCode reports without a code reads exited, with no number', async () => {
    await show(terminal('pty_1', { status: 'exited' }));
    expect(status()?.textContent).toBe('exited');
    expect(status()?.className).toContain('text-muted-foreground');
  });

  test('Stop keeps the row in place as stopped, with its command and its origin link', async () => {
    spies.push(spyOn(opencodeClient, 'getTerminal').mockResolvedValue(terminal('pty_1')));
    const remove = spyOn(opencodeClient, 'removeTerminal').mockResolvedValue(undefined);
    spies.push(remove);
    await show(terminal('pty_1'));

    await act(async () => button('Stop sh -c run pty_1')?.click());

    expect(remove.mock.calls).toEqual([['pty_1', DIRECTORY]]);
    expect(button('Stop')).toBeUndefined();
    expect(status()?.textContent).toBe('stopped');
    expect(dom.container.textContent).toContain('sh -c run pty_1');
    expect(buttons().some((item) => item.textContent === `From ${SESSION}`)).toBe(true);

    // OpenCode's removal event, arriving after the stop settled, keeps the row.
    await act(async () => applyPersistentPtyEvents(DIRECTORY, [{ type: 'persistent-pty.removed', properties: { sessionID: SESSION, ptyID: 'pty_1' } }]));
    expect(status()?.textContent).toBe('stopped');
  });

  test('Stop on a terminal that already exited shows its exit instead of removing it', async () => {
    spies.push(spyOn(opencodeClient, 'getTerminal').mockResolvedValue(terminal('pty_1', { status: 'exited', exitCode: 1 })));
    const remove = spyOn(opencodeClient, 'removeTerminal').mockResolvedValue(undefined);
    spies.push(remove);
    await show(terminal('pty_1'));

    await act(async () => button('Stop sh -c run pty_1')?.click());

    expect(remove.mock.calls).toEqual([]);
    expect(status()?.textContent).toBe('exit code 1');
  });

  test('a failed stop leaves the terminal running and stoppable', async () => {
    spies.push(spyOn(opencodeClient, 'getTerminal').mockResolvedValue(terminal('pty_1')));
    spies.push(spyOn(opencodeClient, 'removeTerminal').mockRejectedValue(new Error('offline')));
    await show(terminal('pty_1'));

    await act(async () => button('Stop sh -c run pty_1')?.click());

    expect(status()?.textContent).toBe('running');
    expect(button('Stop sh -c run pty_1')?.disabled).toBe(false);
  });

  test('dismissing a stopped terminal clears its row without asking OpenCode again', async () => {
    spies.push(spyOn(opencodeClient, 'getTerminal').mockResolvedValue(terminal('pty_1')));
    const remove = spyOn(opencodeClient, 'removeTerminal').mockResolvedValue(undefined);
    spies.push(remove);
    await show(terminal('pty_1'));
    await act(async () => button('Stop sh -c run pty_1')?.click());

    await act(async () => button('Dismiss sh -c run pty_1')?.click());

    expect(remove.mock.calls).toHaveLength(1);
    expect(dom.container.textContent).toBe('');
  });

  test('the output follows the newest line at the bottom, trims the blank rows under it, and stays put once the reader scrolls up', async () => {
    let reads = 0;
    spies.push(spyOn(opencodeClient, 'readTerminalSnapshot').mockImplementation(async () => {
      reads += 1;
      return { info: terminal('pty_1'), text: `line ${reads}\nprompt $ \n\n\n   \n`, checkpoint: '', cursor: { x: 0, y: 0 } };
    }));
    await show(terminal('pty_1'));
    const output = () => dom.container.querySelector('pre');

    await act(async () => button('Show')?.click());
    const pre = output();
    if (!pre) throw new Error('the output is not shown');
    expect(pre.className).toContain('overscroll-contain');
    // A tall screen in a short view: 500 px of text in 100 px.
    Object.defineProperty(pre, 'scrollHeight', { configurable: true, value: 500 });
    Object.defineProperty(pre, 'clientHeight', { configurable: true, value: 100 });
    await act(async () => { await sleep(2_100); });
    expect(pre.textContent).toBe(`line ${reads}\nprompt $`);
    expect(pre.scrollTop).toBe(500);

    // The reader scrolls up to read; the next screen leaves them there.
    await act(async () => {
      pre.scrollTop = 120;
      pre.dispatchEvent(new window.Event('scroll'));
    });
    const before = reads;
    await act(async () => { await sleep(2_100); });
    expect(reads).toBeGreaterThan(before);
    expect(pre.scrollTop).toBe(120);
  });

  test('an exited terminal reads its screen once; a stopped one keeps what it showed and reads nothing more', async () => {
    const snapshot = spyOn(opencodeClient, 'readTerminalSnapshot').mockResolvedValue({ info: terminal('pty_1'), text: 'done', checkpoint: '', cursor: { x: 0, y: 0 } });
    spies.push(snapshot);
    spies.push(spyOn(opencodeClient, 'getTerminal').mockResolvedValue(terminal('pty_1')));
    spies.push(spyOn(opencodeClient, 'removeTerminal').mockResolvedValue(undefined));
    await show(terminal('pty_1'));
    await act(async () => button('Show')?.click());
    expect(dom.container.querySelector('pre')?.textContent).toBe('done');

    await act(async () => button('Stop sh -c run pty_1')?.click());
    const readsAtStop = snapshot.mock.calls.length;
    await act(async () => { await sleep(2_100); });
    expect(snapshot.mock.calls.length).toBe(readsAtStop);
    expect(dom.container.querySelector('pre')?.textContent).toBe('done');

    await act(async () => root.render(null));
    const readsBefore = snapshot.mock.calls.length;
    await show(terminal('pty_2', { status: 'exited', exitCode: 0 }));
    await act(async () => button('Show')?.click());
    await act(async () => { await sleep(2_100); });
    expect(snapshot.mock.calls.length - readsBefore).toBe(1);
  });

  test('a stopped terminal whose output was never shown says its output is gone', async () => {
    spies.push(spyOn(opencodeClient, 'getTerminal').mockResolvedValue(terminal('pty_1')));
    spies.push(spyOn(opencodeClient, 'removeTerminal').mockResolvedValue(undefined));
    const snapshot = spyOn(opencodeClient, 'readTerminalSnapshot').mockRejectedValue(new Error('gone'));
    spies.push(snapshot);
    await show(terminal('pty_1'));
    await act(async () => button('Stop sh -c run pty_1')?.click());

    await act(async () => button('Show')?.click());

    expect(snapshot.mock.calls).toHaveLength(0);
    expect(dom.container.querySelector('pre')?.textContent).toBe('The terminal was removed when it stopped, so its output is gone.');
  });

  test('the expanded list of several terminals scrolls on its own', async () => {
    await act(async () => {
      applyPersistentPtyEvents(DIRECTORY, [
        { type: 'persistent-pty.added', properties: { sessionID: SESSION, terminal: terminal('pty_1') } },
        { type: 'persistent-pty.added', properties: { sessionID: SESSION, terminal: terminal('pty_2') } },
      ]);
    });
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={DIRECTORY}>
        <I18nProvider><PersistentTerminalsStrip sessionId={SESSION} directory={DIRECTORY} /></I18nProvider>
      </SyncProvider>,
    ));
    const header = buttons().find((item) => item.textContent === 'Terminals: 2');
    await act(async () => header?.click());

    const list = document.getElementById(header?.getAttribute('aria-controls') ?? '');
    expect(list?.className).toContain('overflow-y-auto');
    expect(list?.className).toContain('overscroll-contain');
    expect(list?.className).toContain('max-h-[50vh]');
  });
});
