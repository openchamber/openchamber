import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { FilesAPI, GitAPI } from '@/lib/api/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDiffViewTurnNavigation } from './useDiffViewTurnNavigation';
import type { DiffScope, FileEntry } from './types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

const ROOT = '/repo';
const PANEL_SESSION = 'panel-session';
const PINNED_SESSION = 'pinned-session';
const changed: FileEntry = { path: 'src/a.ts', index: ' ', working_dir: 'M', insertions: 1, deletions: 0, isNew: false };

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

let reactRoot: Root | null = null;
let shown: string[] = [];
let statusRead: Deferred;

type Request = { file: string; sessionId: string | null; turnId?: string; panelSessionId: string | null };
type ProbeProps = { request: Request | null; initialScope?: DiffScope; panelSessionId?: string; turnDiffSettled?: boolean };

const Probe: React.FC<ProbeProps> = ({ request, initialScope = 'turn', panelSessionId = PANEL_SESSION, turnDiffSettled = true }) => {
  const [activeDiffScope, setActiveDiffScope] = React.useState<DiffScope>(initialScope);
  // DiffView follows its diffScope prop one render late, in an effect that runs before the hook's.
  React.useEffect(() => { setActiveDiffScope('turn'); }, []);
  const [pending, setPending] = React.useState(request);
  const [, setDisplayFile] = React.useState<string | null>(null);
  const [, setDisplayFileStaged] = React.useState(false);
  const [, setScrollRequestNonce] = React.useState(0);
  const shouldPinAfterAlignRef = React.useRef(false);
  const pendingScrollTargetRef = React.useRef<string | null>(null);
  useDiffViewTurnNavigation({
    visible: true, activeDiffScope, setActiveDiffScope, setDisplayFile, setDisplayFileStaged,
    shouldPinAfterAlignRef, pendingScrollTargetRef, expandStackedFile: (path) => { shown.push(path); },
    setScrollRequestNonce, pendingTurnDiffFile: pending, setPendingTurnDiffFile: setPending, diffScope: 'turn',
    panelSessionId, turnDiffSettled, rootDirectory: ROOT,
    // Snapshots off: the turn diff lists nothing.
    lastTurnDiffs: [], onDiffScopeChange: undefined, effectiveDirectory: ROOT,
    repositoriesKnown: true, rootIsGitRepo: true, nestedRepos: [], repositoryOptions: [],
    selectNestedRepo: async () => {},
    fetchStatus: async () => { await statusRead.promise; return true; },
    // SAFETY: the fallback hands git only to the fetchStatus stub above.
    git: {} as GitAPI,
    changedFiles: [changed],
    // SAFETY: a file inside a repository never reaches the Files API.
    files: {} as FilesAPI,
  });
  return null;
};

const pinnedChip: Request = { file: 'src/a.ts', sessionId: PINNED_SESSION, turnId: 'older-turn', panelSessionId: PANEL_SESSION };

const render = async (props: ProbeProps) => {
  reactRoot ??= createRoot(document.createElement('div'));
  await act(async () => reactRoot?.render(<Probe {...props} />));
};

beforeEach(() => {
  shown = [];
  statusRead = deferred();
  useSessionUIStore.setState({ currentSessionId: PANEL_SESSION });
});

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
});

describe('useDiffViewTurnNavigation', () => {
  test('a pinned chat chip whose file misses the turn list reveals it in Changed', async () => {
    await render({ request: pinnedChip });
    await act(async () => statusRead.resolve());
    expect(shown).toEqual(['src/a.ts']);
  });

  test('a pinned chat chip survives the panel catching up from Working to turn scope', async () => {
    await render({ request: pinnedChip, initialScope: 'working' });
    await act(async () => statusRead.resolve());
    expect(shown).toEqual(['src/a.ts']);
  });

  test('a panel that moves to another session before the snapshot settles drops the request', async () => {
    await render({ request: pinnedChip, turnDiffSettled: false });
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'another-session' }));
    await render({ request: pinnedChip, turnDiffSettled: false, panelSessionId: 'another-session' });
    await render({ request: pinnedChip, panelSessionId: 'another-session' });
    await act(async () => statusRead.resolve());
    expect(shown).toEqual([]);
  });

  test('leaving the panel session drops the pending reveal', async () => {
    await render({ request: pinnedChip });
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'another-session' }));
    await act(async () => statusRead.resolve());
    expect(shown).toEqual([]);
  });
});
