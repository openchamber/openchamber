/**
 * What the stream's `ready` frame asks the provider to repair.
 *
 * A ready frame that resumed the client's cursor replayed every event it
 * missed, so nothing is refetched. A ready frame that reset the replay lost
 * events, so the directory's active sessions are read again. The provider is
 * mounted for real and its socket is the relay fixture the event pipeline tests
 * drive; the refetch is observed as the active-session snapshot a directory
 * resync reads.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { RunningShell } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import { adoptRelayTunnel, deactivateRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient, RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { applyBackgroundShellEvents, resetBackgroundShells, useBackgroundShellsStore } from '@/sync/background-shells';
import { createFakeSocket } from './relay-socket-fixture';

const DIRECTORY = '/repo/resume';
const VIEWED_SESSION = 'ses_viewed';

const DOM_GLOBALS = [
  'window',
  'document',
  'localStorage',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const dom = new Window({ url: 'http://localhost' });
const previousGlobals = DOM_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const name of DOM_GLOBALS) {
  const value = { window: dom, document: dom.document, localStorage: dom.localStorage, navigator: dom.navigator, Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }[name];
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const sockets: RelayTunnelWebSocket[] = [];
const tunnel: RelayTunnelClient = {
  async fetch() { return new Response(null, { status: 503 }) },
  openWebSocket() {
    const socket = createFakeSocket();
    sockets.push(socket);
    return socket;
  },
  getStatus: () => ({ state: 'connected' }),
  subscribeStatus: () => () => undefined,
  retry: () => undefined,
  close: () => undefined,
};

// Directories whose active-session snapshot the provider read, in order.
const snapshotReads: string[] = [];
const readsOf = (directory: string): number => snapshotReads.filter((read) => read === directory).length;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let snapshotSpy: ReturnType<typeof spyOn<typeof opencodeClient, 'getActiveSessionStatuses'>> | null = null;
let setActive: ((directory: string, sessionID: string) => void) | null = null;

beforeEach(() => {
  sockets.length = 0;
  snapshotReads.length = 0;
  adoptRelayTunnel({ relayUrl: 'wss://relay.test', serverId: 'resume-fixture', hostEncPubJwk: {} }, tunnel);
  // A valid URL token lets the socket open without minting one.
  setRuntimeUrlAuthToken('fixture-url-token', Date.now() + 10 * 60_000);
  // The viewed session is running, so the directory has work a reconnect must repair.
  snapshotSpy = spyOn(opencodeClient, 'getActiveSessionStatuses').mockImplementation(async (directory?: string) => {
    snapshotReads.push(directory ?? '');
    return { [VIEWED_SESSION]: { type: 'busy' } };
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  setActive?.('', '');
  snapshotSpy?.mockRestore();
  deactivateRelayTunnel();
  clearRuntimeUrlAuthToken();
});

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

/** Mounts the provider on a directory with one session being viewed, and waits for its socket to open. */
const mountProvider = async (): Promise<void> => {
  const { SyncProvider, setActiveSession } = await import('@/sync/sync-context');
  setActive = setActiveSession;
  const sdk = OpenCode.make({ baseUrl: 'http://resume.test', fetch: () => new Promise<Response>(() => undefined) });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(
    <SyncProvider sdk={sdk} directory={DIRECTORY}>
      <div />
    </SyncProvider>,
  ));
  setActiveSession(DIRECTORY, VIEWED_SESSION);
  for (let attempt = 0; attempt < 200 && sockets.length === 0; attempt += 1) {
    await act(async () => { await sleep(10); });
  }
  expect(sockets.length).toBeGreaterThan(0);
  // Let the bootstrap's own reads finish, so the reads counted later are the reconnect's.
  await act(async () => { await sleep(100); });
};

/** Delivers one frame on the stream socket the provider opened. */
const deliverReady = async (frame: { resumed: boolean; replayReset: boolean }): Promise<void> => {
  const socket = sockets.at(-1);
  if (!socket) throw new Error('the stream socket is not open');
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify({ type: 'ready', ...frame }) });
    await sleep(100);
  });
};

// The provider treats the first ready as its first connect, and a ready within
// the boot window as part of startup. Both skip the refetch for reasons that
// have nothing to do with the replay, so the frame under test comes after both.
const BOOT_WINDOW_MS = 1_500;

/** A first connect, then a reconnect once the boot window has closed: the only frame that can refetch is the one under test. */
const reconnectAfterBootWindow = async (frame: { resumed: boolean; replayReset: boolean }): Promise<void> => {
  await deliverReady({ resumed: false, replayReset: false });
  await act(async () => { await sleep(BOOT_WINDOW_MS + 100); });
  await deliverReady(frame);
};

describe('SyncProvider stream reconnect', () => {
  test('a reconnect whose ready resumed the cursor refetches nothing', async () => {
    await mountProvider();
    const before = readsOf(DIRECTORY);

    await reconnectAfterBootWindow({ resumed: true, replayReset: false });

    expect(readsOf(DIRECTORY)).toBe(before);
  });

  test('a reconnect whose ready reset the replay refetches the directory active sessions', async () => {
    await mountProvider();
    const before = readsOf(DIRECTORY);

    await reconnectAfterBootWindow({ resumed: false, replayReset: true });

    expect(readsOf(DIRECTORY)).toBeGreaterThan(before);
  });
});

/**
 * A command whose end fell into the gap. The OpenCode stream never restarted,
 * so no `server.connected` arrives: only the client's own reconnect can
 * notice, and only by reading the command lists again.
 */
describe('SyncProvider stream reconnect and background commands', () => {
  const OTHER_DIRECTORY = '/repo/no-store';
  const listReads: string[] = [];
  let listSpy: ReturnType<typeof spyOn<typeof opencodeClient, 'listRunningShells'>> | null = null;
  let endSpy: ReturnType<typeof spyOn<typeof opencodeClient, 'readShellEnd'>> | null = null;

  const runningShell = (id: string): RunningShell => ({ id, sessionID: VIEWED_SESSION, command: `bun run ${id}`, file: `/tmp/${id}.out`, startedAt: 1 });

  beforeEach(() => {
    resetBackgroundShells();
    listReads.length = 0;
    // OpenCode no longer runs anything: both commands ended during the gap,
    // and it kept no record of how.
    listSpy = spyOn(opencodeClient, 'listRunningShells').mockImplementation(async (directory: string) => {
      listReads.push(directory);
      return { directory, shells: [] };
    });
    endSpy = spyOn(opencodeClient, 'readShellEnd').mockResolvedValue(undefined);
  });

  afterEach(() => {
    listSpy?.mockRestore();
    endSpy?.mockRestore();
    resetBackgroundShells();
  });

  /** Two commands seen running before the gap: one in the shown directory, one in a directory without a store. */
  const startCommands = async (): Promise<void> => {
    await act(async () => {
      applyBackgroundShellEvents(DIRECTORY, [{ type: 'shell.started', properties: { shell: runningShell('sh_here') } }]);
      applyBackgroundShellEvents(OTHER_DIRECTORY, [{ type: 'shell.started', properties: { shell: runningShell('sh_there') } }]);
    });
    expect([...useBackgroundShellsStore.getState().byId.keys()].sort()).toEqual(['sh_here', 'sh_there']);
    listReads.length = 0;
  };

  test('a reconnect that resumed the cursor reads no command list', async () => {
    await mountProvider();
    await startCommands();

    await reconnectAfterBootWindow({ resumed: true, replayReset: false });

    expect(listReads).toEqual([]);
    expect(useBackgroundShellsStore.getState().byId.size).toBe(2);
  });

  test('a reconnect that lost events reads the command list of every directory running one, and the ended commands leave', async () => {
    await mountProvider();
    await startCommands();

    await reconnectAfterBootWindow({ resumed: false, replayReset: true });

    expect([...new Set(listReads)].sort()).toEqual([DIRECTORY, OTHER_DIRECTORY].sort());
    expect(useBackgroundShellsStore.getState().byId.size).toBe(0);
    expect(useBackgroundShellsStore.getState().ended.get('sh_here')?.status).toBe('unknown');
  });
});
