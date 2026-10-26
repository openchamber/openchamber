import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { adoptSessionMove } from '@/sync/session-actions';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';

import { usePinnedSessionDirectory } from './usePinnedSessionDirectory';

// Directory stores persist their session lists, so each test gets its own pair.
let run = 0;
let parentDirectory = '';
let worktreeDirectory = '';

const child = (directory: string): Session => ({
  id: 'child',
  parentID: 'parent',
  projectID: 'project',
  directory,
  title: 'Child',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

describe('a pinned chat column follows its session across a move', () => {
  let win: Window;
  let root: Root;
  let restoreGlobals: () => void;
  let shown: string | null = null;
  const sdk = OpenCode.make({ baseUrl: 'http://pinned.test', fetch: () => new Promise<Response>(() => undefined) });

  const Probe = ({ directory }: { directory: string | null }) => {
    shown = usePinnedSessionDirectory({ sessionId: 'child', directory });
    return null;
  };
  const render = async (directory: string | null) => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={parentDirectory}>
        <Probe directory={directory} />
      </SyncProvider>,
    ));
  };
  const publishChild = async (session: Session) => {
    const store = getSyncChildStores().ensureChild(parentDirectory, { bootstrap: false });
    await act(async () => store.setState({ session: [session], sessionTotal: 1 }));
  };

  beforeEach(() => {
    run += 1;
    parentDirectory = `/pinned-${run}/repo`;
    worktreeDirectory = `/pinned-${run}/repo-wt`;
    win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    root = createRoot(document.createElement('div'));
    shown = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('reads the destination once OpenCode moves the session', async () => {
    await render(parentDirectory);
    await publishChild(child(parentDirectory));
    expect(shown).toBe(parentDirectory);

    await act(async () => adoptSessionMove('child', parentDirectory, worktreeDirectory));

    expect(shown).toBe(worktreeDirectory);
  });

  test('keeps the opened directory until the record is known or while it names the same place', async () => {
    await render(parentDirectory);
    expect(shown).toBe(parentDirectory);

    await publishChild(child(`${parentDirectory}/`));
    expect(shown).toBe(parentDirectory);
  });
});
