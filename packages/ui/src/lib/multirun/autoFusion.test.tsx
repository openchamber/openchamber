import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { applyGlobalSessionStatusEvents, replaceGlobalSessionStatusById, setSessionParentResolver } from '@/sync/global-session-status';
import { buildMultiRunIndex } from './runs';
import { withMultiRunMembership } from './identity';
import { RUN_LAUNCHER_ID } from './launcher';

const sessionById = new Map<string, Session>();
const fusionCalls: Parameters<typeof import('./fusion').startRunFusion>[0][] = [];
const startRunFusion = async (input: Parameters<typeof import('./fusion').startRunFusion>[0]) => { fusionCalls.push(input); };
mock.module('./fusion', () => ({ startRunFusion, NoFusionOutputsError: class extends Error {} }));
mock.module('./useMultiRuns', () => ({
  useMultiRunSessions: () => ({ index: buildMultiRunIndex(sessionById.values(), () => '/repo'), sessionById }),
}));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => ({ providers: [] }) } }));
mock.module('@/components/ui', () => ({ toast: { error: mock(() => {}) } }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const { RunAutoFusion } = await import('./autoFusion');

async function checkAutoFusion(batched: boolean): Promise<void> {
  const laneA = `lane-a-${batched}`;
  const laneB = `lane-b-${batched}`;
  const child = `child-${batched}`;
  const grandchild = `grandchild-${batched}`;
  fusionCalls.length = 0;
  const dom = new Window({ url: 'http://fusion.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.createElement('div'));
  const session = (id: string, parentID?: string): Session => ({
    id, parentID, projectID: 'project', directory: parentID ? '/repo/child' : '/repo', title: id, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2, idle: 2 }, outcome: 'succeeded',
  });
  for (const id of [laneA, laneB]) {
    sessionById.set(id, {
      ...session(id),
      metadata: withMultiRunMembership({}, {
        version: 1, sessionID: id,
        group: { kind: 'id', id: batched ? '9f512893-6e63-4e49-a534-5de733ca103f' : '9f512893-6e63-4e49-a534-5de733ca103e' },
        groupSlug: 'fusion-test', role: 'run', providerID: 'test', modelID: id,
        autoFusion: { providerID: 'test', modelID: 'judge', launcherId: RUN_LAUNCHER_ID },
      }),
    });
  }
  sessionById.set(child, session(child, laneA));
  sessionById.set(grandchild, session(grandchild, child));
  // Deliberately leave the display resolver empty. Fusion has its own complete
  // session map, including children outside the currently selected directory.
  setSessionParentResolver(() => undefined);
  const update = async (...activeIds: string[]) => {
    await act(async () => {
      replaceGlobalSessionStatusById(new Map(activeIds.map((id) => [id, { directory: sessionById.get(id)?.directory ?? '/repo', status: { type: 'busy' as const } }])));
      root.render(<RunAutoFusion />);
    });
  };
  try {
    await update('unrelated');
    expect(fusionCalls.length).toBe(0);
    await update(laneA, laneB, child);
    if (batched) {
      // One reducer publication and React render for both completions.
      await act(async () => {
        applyGlobalSessionStatusEvents('/repo', [laneA, laneB, child].map((sessionID) => ({
          type: 'session.idle' as const, properties: { sessionID },
        })));
        // Directory session records publish after the global status transitions.
        const parent = sessionById.get(laneA);
        if (!parent) throw new Error('Missing parent fixture');
        sessionById.set(parent.id, { ...parent, time: { ...parent.time, updated: 3, idle: 3 } });
        root.render(<RunAutoFusion />);
      });
    } else {
      await update(child);
      expect(fusionCalls.length).toBe(0);
      await update(grandchild);
      expect(fusionCalls.length).toBe(0);
      // The child can settle before the parent receives and processes its result.
      await update();
    }
    expect(fusionCalls.length).toBe(0);
    await update('unrelated');
    expect(fusionCalls.length).toBe(0);
    // A fast parent resumption may publish its busy and idle events together.
    // Its newer completion is authoritative even without a busy render.
    const parent = sessionById.get(laneA);
    if (!parent) throw new Error('Missing parent fixture');
    sessionById.set(parent.id, { ...parent, time: { ...parent.time, updated: 4, idle: 4 } });
    if (batched) {
      await act(async () => {
        applyGlobalSessionStatusEvents('/repo', [
          { type: 'session.status', properties: { sessionID: laneA, status: { type: 'busy' } } },
          { type: 'session.idle', properties: { sessionID: laneA } },
        ]);
        root.render(<RunAutoFusion />);
      });
    } else await update('unrelated');
    expect(fusionCalls.length).toBe(1);
    expect(fusionCalls[0]?.sourceIds).toEqual([laneA, laneB]);
    await update();
    expect(fusionCalls.length).toBe(1);
  } finally {
    await act(async () => root.unmount());
    replaceGlobalSessionStatusById(new Map());
    sessionById.clear();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
}

for (const batched of [false, true]) {
  test(`automatic fusion waits for a newer parent completion, batched events: ${batched}`, () => checkAutoFusion(batched));
}
