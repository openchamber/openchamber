import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { toast } from '@/components/ui';
import type { Session } from '@/lib/opencode/model';
import type { SessionPatch, SyncEvent } from '@/lib/opencode/events';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionCostSettingsStore } from '@/stores/useSessionCostSettingsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { computeRollup } from '@/components/chat/work-status/useSubagentCostRollup';
import { sessionCostLevel } from '@/components/chat/work-status/sessionCostLevel';
import { opencodeClient } from '@/lib/opencode/client';
import { applySessionEventsToGlobalSessions, readDeferredGlobalUpdates, readGlobalSessionTree, readSessionCostTree } from './session-event-router';
import { notifyStreamGap } from './stream-gap';
import { ChildStoreManager } from './child-store';
import { getSyncSessionSlices, setSyncRefs } from './sync-refs';
import { countSessionCostMembershipBuilds } from './session-cost-tree';

const session = (id: string, cost: number, parentID?: string, directory = '/project'): Session => {
  const record: Session = {
    id, directory, projectID: 'external', title: `title ${id}`, time: { created: 1, updated: 1 },
    cost, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  if (parentID) record.parentID = parentID;
  return record;
};
const created = (info: Session): SyncEvent => ({ type: 'session.created', properties: { info } });
const spend = (sessionID: string, cost: number): SyncEvent => ({
  type: 'session.patched',
  properties: { sessionID, patch: { cost } satisfies SessionPatch },
});

type Shown = { level: 'warn' | 'critical'; title: string; id: unknown; description: unknown };
let shown: Shown[] = [];
let restore: Array<() => void> = [];

beforeEach(() => {
  shown = [];
  useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [], entityById: new Map(), hasLoaded: true });
  useSessionCostSettingsStore.setState({
    sessionCostAlertsEnabled: true, sessionCostWarnThreshold: 5, sessionCostCriticalThreshold: 20, runtimeKey: getRuntimeKey(),
  });
  const warning = spyOn(toast, 'warning').mockImplementation((title, data) => {
    shown.push({ level: 'warn', title: String(title), id: data?.id, description: data?.description });
    return 1;
  });
  const error = spyOn(toast, 'error').mockImplementation((title, data) => {
    shown.push({ level: 'critical', title: String(title), id: data?.id, description: data?.description });
    return 1;
  });
  restore = [() => warning.mockRestore(), () => error.mockRestore()];
});

afterEach(() => {
  for (const undo of restore) undo();
});

const mountDirectory = (directory: string, sessions: Session[]) => {
  const childStores = new ChildStoreManager();
  const store = childStores.ensureChild(directory, { bootstrap: false });
  store.setState({ session: sessions });
  setSyncRefs(opencodeClient.getSdkClient(), childStores, directory);
  restore.push(() => childStores.disposeAll());
  return store;
};

// What Work status reads: the same tree builder over the mounted directory stores.
const cardTotal = (rootId: string) => computeRollup(
  readSessionCostTree(useGlobalSessionsStore.getState(), readDeferredGlobalUpdates(), getSyncSessionSlices()),
  rootId,
).totalCost;

describe('session cost alerts', () => {
  test('warns once when a subagent pushes its parent over the yellow amount, then once more at red', () => {
    const store = useGlobalSessionsStore.getState();
    store.upsertSession(session('root-a', 4));
    store.upsertSession(session('child-a', 0, 'root-a'));

    applySessionEventsToGlobalSessions([spend('child-a', 1.5)]);
    expect(shown).toEqual([{ level: 'warn', title: 'Session cost passed $5', id: 'session-cost-root-a', description: 'title root-a' }]);

    applySessionEventsToGlobalSessions([spend('root-a', 6), spend('child-a', 3)]);
    expect(shown).toHaveLength(1);

    applySessionEventsToGlobalSessions([spend('root-a', 18)]);
    expect(shown.map((entry) => [entry.level, entry.title])).toEqual([
      ['warn', 'Session cost passed $5'],
      ['critical', 'Session cost passed $20'],
    ]);
  });

  test('stays quiet for a session that was already over the amount before the live spend', () => {
    useGlobalSessionsStore.getState().upsertSession(session('root-b', 30));
    applySessionEventsToGlobalSessions([spend('root-b', 31)]);
    expect(shown).toEqual([]);
  });

  test('stays quiet while the setting is off', () => {
    useSessionCostSettingsStore.setState({ sessionCostAlertsEnabled: false });
    useGlobalSessionsStore.getState().upsertSession(session('root-c', 0));
    applySessionEventsToGlobalSessions([spend('root-c', 25)]);
    expect(shown).toEqual([]);
  });

  test('announces a raised amount after an earlier alert at the old one', () => {
    useGlobalSessionsStore.getState().upsertSession(session('root-d', 0));
    applySessionEventsToGlobalSessions([spend('root-d', 6)]);
    useSessionCostSettingsStore.setState({ sessionCostWarnThreshold: 10 });
    applySessionEventsToGlobalSessions([spend('root-d', 11)]);
    expect(shown.map((entry) => entry.title)).toEqual(['Session cost passed $5', 'Session cost passed $10']);
  });

  test('counts a subagent created in the same batch it spends in', () => {
    useGlobalSessionsStore.getState().upsertSession(session('root-e', 4));
    applySessionEventsToGlobalSessions([created(session('child-e', 0, 'root-e')), spend('child-e', 2)]);
    applySessionEventsToGlobalSessions([spend('child-e', 2.5)]);
    expect(shown.map((entry) => [entry.id, entry.title])).toEqual([['session-cost-root-e', 'Session cost passed $5']]);
  });

  test('stays quiet when a new subagent spends under a parent already over the amount', () => {
    useGlobalSessionsStore.getState().upsertSession(session('root-f', 5.5));
    applySessionEventsToGlobalSessions([created(session('child-f', 0, 'root-f')), spend('child-f', 1)]);
    expect(shown).toEqual([]);
  });

  test('takes the first cost of a record without one, as the persisted seed has, as the baseline', () => {
    const seeded = session('root-g', 0);
    Reflect.deleteProperty(seeded, 'cost');
    useGlobalSessionsStore.getState().upsertSession(seeded);
    applySessionEventsToGlobalSessions([spend('root-g', 25)]);
    expect(shown).toEqual([]);
    useSessionCostSettingsStore.setState({ sessionCostCriticalThreshold: 30 });
    applySessionEventsToGlobalSessions([spend('root-g', 31)]);
    expect(shown.map((entry) => entry.title)).toEqual(['Session cost passed $30']);
  });

  test('announces spend the server replays after a stream gap', () => {
    useGlobalSessionsStore.getState().upsertSession(session('root-h', 4));
    notifyStreamGap(getRuntimeKey());
    applySessionEventsToGlobalSessions([spend('root-h', 6)]);
    expect(shown.map((entry) => entry.title)).toEqual(['Session cost passed $5']);
  });

  test('colors the card for old spend a grandchild outside the mounted folders loads with, without a notice', () => {
    const store = useGlobalSessionsStore.getState();
    store.upsertSession(session('root-i', 1));
    store.upsertSession(session('child-i', 1, 'root-i'));
    store.upsertSession(session('grandchild-i', 1, 'child-i', '/elsewhere'));
    const card = () => {
      const { totalCost } = computeRollup(readGlobalSessionTree(useGlobalSessionsStore.getState(), readDeferredGlobalUpdates()), 'root-i');
      return { totalCost, level: sessionCostLevel(totalCost ?? 0, { warn: 5, critical: 20 }) };
    };

    store.upsertSession(session('loaded-i', 25, 'child-i', '/elsewhere'));
    expect(shown).toEqual([]);
    expect(card()).toEqual({ totalCost: 28, level: 'critical' });
  });

  test('announces the crossing a grandchild outside the mounted folders causes, at the total the card shows', () => {
    const store = useGlobalSessionsStore.getState();
    store.upsertSession(session('root-j', 1));
    store.upsertSession(session('child-j', 1, 'root-j'));
    store.upsertSession(session('grandchild-j', 1, 'child-j', '/elsewhere'));

    applySessionEventsToGlobalSessions([spend('grandchild-j', 4)]);
    const { totalCost } = computeRollup(readGlobalSessionTree(useGlobalSessionsStore.getState(), readDeferredGlobalUpdates()), 'root-j');
    expect(totalCost).toBe(6);
    expect(sessionCostLevel(totalCost ?? 0, { warn: 5, critical: 20 })).toBe('warn');
    expect(shown.map((entry) => [entry.id, entry.title])).toEqual([['session-cost-root-j', 'Session cost passed $5']]);
  });

  test('counts spend of a subagent only the mounted folder holds, in the card and the notice alike', () => {
    useGlobalSessionsStore.getState().upsertSession(session('root-k', 4));
    const directory = mountDirectory('/project', [session('root-k', 4), session('child-k', 0, 'root-k')]);

    applySessionEventsToGlobalSessions([spend('child-k', 2)]);
    expect(shown.map((entry) => [entry.id, entry.title])).toEqual([['session-cost-root-k', 'Session cost passed $5']]);

    directory.setState({ session: [session('root-k', 4), session('child-k', 2, 'root-k')] });
    expect(cardTotal('root-k')).toBe(6);
  });

  test('stays quiet when a folder-only subagent loads with old spend', () => {
    useGlobalSessionsStore.getState().upsertSession(session('root-l', 4));
    mountDirectory('/project', [session('root-l', 4), session('child-l', 30, 'root-l')]);
    expect(cardTotal('root-l')).toBe(34);
    applySessionEventsToGlobalSessions([spend('child-l', 30.5)]);
    expect(shown).toEqual([]);
  });

  test('reuses the folder index when usage changes only a cost', () => {
    useGlobalSessionsStore.getState().upsertSession(session('root-m', 1));
    const directory = mountDirectory('/project', [session('root-m', 1), session('child-m', 1, 'root-m')]);
    expect(cardTotal('root-m')).toBe(2);
    const builds = countSessionCostMembershipBuilds();

    directory.setState({ session: [session('root-m', 1), session('child-m', 3, 'root-m')] });
    expect(cardTotal('root-m')).toBe(4);
    expect(countSessionCostMembershipBuilds()).toBe(builds);

    directory.setState({ session: [session('root-m', 1), session('child-m', 3, 'root-m'), session('child-m2', 1, 'root-m')] });
    expect(cardTotal('root-m')).toBe(5);
    expect(countSessionCostMembershipBuilds()).toBe(builds + 1);
  });
});
