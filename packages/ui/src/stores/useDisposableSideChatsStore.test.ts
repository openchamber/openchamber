import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  parseDisposableSideChatsRegistry,
  useDisposableSideChatsStore,
  isDisposableSideChatSession,
} from './useDisposableSideChatsStore';

const target = {
  runtimeKey: 'runtime-a',
  directory: '/repo',
  parentSessionId: 'parent',
};

describe('useDisposableSideChatsStore', () => {
  beforeEach(() => {
    useDisposableSideChatsStore.setState({
      entries: new Map(),
      entryKeyByParent: new Map(),
      entryKeyBySide: new Map(),
      mutationRevision: 0,
      tombstones: new Map(),
      runtimeGeneration: 0,
      activeRuntimeKey: 'runtime-a',
      hydrationStatus: 'missing',
    });
  });

  test('distinguishes missing, empty, and malformed persisted registries', () => {
    expect(parseDisposableSideChatsRegistry(null).status).toBe('missing');
    expect(parseDisposableSideChatsRegistry(JSON.stringify({ version: 1, entries: [] }))).toEqual({
      status: 'ready',
      entries: [],
      tombstones: [],
    });
    expect(parseDisposableSideChatsRegistry('{not-json').status).toBe('error');
    expect(parseDisposableSideChatsRegistry(JSON.stringify({ version: 2, entries: [] })).status).toBe('error');
  });

  test('owns one side chat per runtime, directory, and parent and survives cleanup-pending reload', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening(target);
    const repeatedKey = useDisposableSideChatsStore.getState().beginOpening(target);
    expect(repeatedKey).toBe(openingKey);

    useDisposableSideChatsStore.getState().bindSideSession(openingKey!, 'side', 'runtime-a');
    useDisposableSideChatsStore.getState().setPhase({ ...target, sideSessionId: 'side' }, 'cleanup-pending');

    const persisted = useDisposableSideChatsStore.getState().serialize();
    useDisposableSideChatsStore.setState({
      entries: new Map(), entryKeyByParent: new Map(), entryKeyBySide: new Map(), mutationRevision: 0, hydrationStatus: 'missing',
    });
    useDisposableSideChatsStore.getState().hydrateSerialized(persisted, 'runtime-a');

    const recovered = useDisposableSideChatsStore.getState().findByParent(target);
    expect(recovered?.sideSessionId).toBe('side');
    expect(recovered?.phase).toBe('cleanup-pending');
  });

  test('bounds persisted recovery ownership to the newest entries', () => {
    for (let index = 0; index < 55; index += 1) {
      useDisposableSideChatsStore.getState().beginOpening({
        ...target,
        parentSessionId: `parent-${index}`,
      });
    }

    expect(useDisposableSideChatsStore.getState().entries.size).toBe(50);
  });

  test('never evicts unresolved cleanup or promotion ownership from bounds', () => {
    for (let index = 0; index < 55; index += 1) {
      const opening = useDisposableSideChatsStore.getState().beginOpening({ ...target, parentSessionId: `parent-${index}` })!;
      useDisposableSideChatsStore.getState().bindSideSession(opening, `side-${index}`, 'runtime-a');
    }
    const protectedTarget = { ...target, parentSessionId: 'protected' };
    const protectedOpening = useDisposableSideChatsStore.getState().beginOpening(protectedTarget)!;
    useDisposableSideChatsStore.getState().bindSideSession(protectedOpening, 'protected-side', 'runtime-a');
    useDisposableSideChatsStore.getState().setPhase({ ...protectedTarget, sideSessionId: 'protected-side' }, 'cleanup-pending');

    for (let index = 55; index < 110; index += 1) {
      const opening = useDisposableSideChatsStore.getState().beginOpening({ ...target, parentSessionId: `parent-${index}` })!;
      useDisposableSideChatsStore.getState().bindSideSession(opening, `side-${index}`, 'runtime-a');
    }

    expect(useDisposableSideChatsStore.getState().findBySide('runtime-a', '/repo', 'protected-side')?.phase).toBe('cleanup-pending');
  });

  test('does not let hydration overwrite a newer local mutation', async () => {
    let resolveRead!: (value: string | null) => void;
    const read = new Promise<string | null>((resolve) => { resolveRead = resolve; });
    const hydration = useDisposableSideChatsStore.getState().hydrateFrom(() => read, 'runtime-a');

    useDisposableSideChatsStore.getState().beginOpening(target);
    resolveRead(JSON.stringify({ version: 1, entries: [] }));
    await hydration;

    expect(useDisposableSideChatsStore.getState().findByParent(target)?.phase).toBe('opening');
  });

  test('rolls back only an unbound opening owned by the active runtime', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening(target)!;
    useDisposableSideChatsStore.getState().cancelOpening(openingKey, 'runtime-b');
    expect(useDisposableSideChatsStore.getState().entries.has(openingKey)).toBe(true);

    useDisposableSideChatsStore.getState().cancelOpening(openingKey, 'runtime-a');
    expect(useDisposableSideChatsStore.getState().entries.has(openingKey)).toBe(false);
  });

  test('rejects stale runtime completion and clears only matching not-found ownership', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening(target)!;
    useDisposableSideChatsStore.getState().resetForRuntimeSwitch('runtime-b');
    expect(useDisposableSideChatsStore.getState().bindSideSession(openingKey, 'side', 'runtime-a')).not.toBeNull();

    useDisposableSideChatsStore.getState().resetForRuntimeSwitch('runtime-a');
    const first = [...useDisposableSideChatsStore.getState().entries.keys()].find((key) => key.includes('"side"'))!;
    const other = useDisposableSideChatsStore.getState().beginOpening({ ...target, parentSessionId: 'other-parent' })!;
    const otherBound = useDisposableSideChatsStore.getState().bindSideSession(other, 'other-side', 'runtime-a')!;
    useDisposableSideChatsStore.getState().reconcileNotFound({ ...target, sideSessionId: 'side' });

    expect(useDisposableSideChatsStore.getState().entries.has(first)).toBe(false);
    expect(useDisposableSideChatsStore.getState().entries.has(otherBound)).toBe(true);
  });

  test('binds a successful response to the captured runtime after the active runtime changes', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening(target)!;
    useDisposableSideChatsStore.getState().resetForRuntimeSwitch('runtime-b');

    expect(useDisposableSideChatsStore.getState().bindSideSession(openingKey, 'side', 'runtime-a')).not.toBeNull();
    expect(useDisposableSideChatsStore.getState().findBySide('runtime-a', '/repo', 'side')?.phase).toBe('open');
  });

  test('reconstructs missing ownership from authoritative session metadata', () => {
    useDisposableSideChatsStore.getState().reconcileSessions([{
      id: 'side', parentID: 'parent', directory: '/repo', time: { created: 1 },
      metadata: { openchamber: { sideChat: { disposable: true, parentSessionID: 'parent' } } },
    } as unknown as Session], 'runtime-a');

    const recovered = useDisposableSideChatsStore.getState().findBySide('runtime-a', '/repo', 'side');
    expect(recovered?.parentSessionId).toBe('parent');
    expect(recovered?.phase).toBe('open');
  });

  test('suppresses marked, owned, and parent-scoped opening sessions without hiding ordinary sessions', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening(target)!;
    const transient = { id: 'side', parentID: 'parent', directory: '/repo', time: { created: 1, updated: 1 } } as Session;
    expect(isDisposableSideChatSession(transient, 'runtime-a')).toBe(true);

    const boundKey = useDisposableSideChatsStore.getState().bindSideSession(openingKey, 'side', 'runtime-a')!;
    expect(isDisposableSideChatSession({ ...transient, parentID: undefined } as Session, 'runtime-a')).toBe(true);
    expect(useDisposableSideChatsStore.getState().entries.has(boundKey)).toBe(true);
    expect(isDisposableSideChatSession({ ...transient, id: 'ordinary', parentID: 'other' } as Session, 'runtime-a')).toBe(false);
  });

  test('changes phase by semantic identity without exposing registry keys', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening(target)!;
    useDisposableSideChatsStore.getState().bindSideSession(openingKey, 'side', 'runtime-a');

    useDisposableSideChatsStore.getState().setPhase({ ...target, sideSessionId: 'side' }, 'promotion-pending');

    expect(useDisposableSideChatsStore.getState().findBySide('runtime-a', '/repo', 'side')?.phase).toBe('promotion-pending');
  });

  test('keeps parent and side indexes synchronized after completion', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening(target)!;
    useDisposableSideChatsStore.getState().bindSideSession(openingKey, 'side', 'runtime-a');
    const identity = { ...target, sideSessionId: 'side' };

    useDisposableSideChatsStore.getState().complete(identity);

    expect(useDisposableSideChatsStore.getState().findByParent(target)).toBeNull();
    expect(useDisposableSideChatsStore.getState().findBySide('runtime-a', '/repo', 'side')).toBeNull();
  });

  test('normalizes indexed lookup directories', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening({ ...target, directory: '/repo/' })!;
    useDisposableSideChatsStore.getState().bindSideSession(openingKey, 'side', 'runtime-a');

    expect(useDisposableSideChatsStore.getState().findBySide('runtime-a', '/repo/', 'side')?.directory).toBe('/repo');
  });

  test('merges newer external ownership and prevents a stale tab from resurrecting completed ownership', () => {
    const openingKey = useDisposableSideChatsStore.getState().beginOpening(target)!;
    useDisposableSideChatsStore.getState().bindSideSession(openingKey, 'side', 'runtime-a');
    const stale = useDisposableSideChatsStore.getState().serialize();
    useDisposableSideChatsStore.getState().complete({ ...target, sideSessionId: 'side' });
    const completed = useDisposableSideChatsStore.getState().serialize();

    useDisposableSideChatsStore.getState().reconcileSerialized(stale);
    expect(useDisposableSideChatsStore.getState().findBySide('runtime-a', '/repo', 'side')).toBeNull();

    useDisposableSideChatsStore.setState({ entries: new Map(), entryKeyByParent: new Map(), entryKeyBySide: new Map(), tombstones: new Map() });
    useDisposableSideChatsStore.getState().reconcileSerialized(stale);
    useDisposableSideChatsStore.getState().reconcileSerialized(completed);
    expect(useDisposableSideChatsStore.getState().findBySide('runtime-a', '/repo', 'side')).toBeNull();
  });
});
