import { afterAll, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { ProjectPlanLink, ProjectRef } from '@/lib/projectContextApi';

const browser = new Window({ url: 'http://runtime.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const moves: string[] = [];
const errors: string[] = [];
const storeState = {
  movePlan: async (_project: ProjectRef, planId: string) => {
    moves.push(planId);
    return 'moved-id';
  },
  deletePlan: async () => true,
  getEntry: () => ({ error: null }),
};
mock.module('@/stores/useProjectContextStore', () => ({
  useProjectContextStore: Object.assign(
    <T,>(select: (state: typeof storeState) => T): T => select(storeState),
    { getState: () => storeState },
  ),
}));
mock.module('@/components/ui', () => ({ toast: { error: (message: string) => { errors.push(message); } } }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/router/openSessionFromRoute', () => ({ openSessionLink: async () => {} }));

const { createRoot } = await import('react-dom/client');
const { resolveProjectContextId } = await import('@/lib/projectContextApi');
const { registerOpenPlan } = await import('./openPlanViews');
const { usePlanActions } = await import('./usePlanActions');

const projectRef = { id: 'p', path: '/project' };
const plan: ProjectPlanLink = { id: 'shared:team.md', file: 'team.md', title: 'Team', createdAt: 1, pinned: false, source: 'shared' };
const movedTo: Array<[string, string, string]> = [];
let actions: ReturnType<typeof usePlanActions> | null = null;
const Probe = () => {
  actions = usePlanActions(projectRef, (...args) => { movedTo.push(args); });
  return null;
};
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
await act(async () => root.render(<Probe />));

const move = async () => {
  const item = actions!.actionsFor(plan).find((action) => action.id === 'move');
  await act(async () => {
    item!.onSelect();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

afterAll(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('an open plan whose typing could not be saved is not moved, and gets its editor back', async () => {
  const held: boolean[] = [];
  const unregister = registerOpenPlan(resolveProjectContextId(projectRef), plan.id, {
    setHeld: (value) => { held.push(value); },
    flush: async () => false,
  });
  await move();
  unregister();
  expect(moves).toEqual([]);
  expect(movedTo).toEqual([]);
  expect(errors).toEqual(['rightSidebar.contextNotesTodo.toast.movePlanFailed']);
  // Registered writable, held for the move, given back.
  expect(held).toEqual([false, true, false]);
});

test('an open plan is held while its typing is written, then moved and followed to its new id', async () => {
  const events: string[] = [];
  const unregister = registerOpenPlan(resolveProjectContextId(projectRef), plan.id, {
    setHeld: (value) => { events.push(value ? 'hold' : 'writable'); },
    flush: async () => {
      events.push(`flush before move: ${moves.length === 0}`);
      return true;
    },
  });
  await move();
  unregister();
  expect(events).toEqual(['writable', 'hold', 'flush before move: true', 'writable']);
  expect(moves).toEqual([plan.id]);
  expect(movedTo).toEqual([[resolveProjectContextId(projectRef), plan.id, 'moved-id']]);
});

test('a view of the plan opened while the move runs is held until the move ends', async () => {
  const { holdOpenPlan } = await import('./openPlanViews');
  const projectId = resolveProjectContextId(projectRef);
  const first: boolean[] = [];
  const unregisterFirst = registerOpenPlan(projectId, 'plan-x', { setHeld: (value) => { first.push(value); }, flush: async () => true });
  const held = await holdOpenPlan(projectId, 'plan-x');
  // Closed and opened again before the move finished.
  unregisterFirst();
  const second: boolean[] = [];
  const unregisterSecond = registerOpenPlan(projectId, 'plan-x', { setHeld: (value) => { second.push(value); }, flush: async () => true });
  expect(second).toEqual([true]);
  held.release();
  expect(second).toEqual([true, false]);
  expect(first).toEqual([false, true]);
  unregisterSecond();
});

test('a view that moves on to another plan during a move takes its editor back', async () => {
  const { holdOpenPlan } = await import('./openPlanViews');
  const projectId = resolveProjectContextId(projectRef);
  let held = false;
  const view = { setHeld: (value: boolean) => { held = value; }, flush: async () => true };
  const unregisterA = registerOpenPlan(projectId, 'plan-a', view);
  const hold = await holdOpenPlan(projectId, 'plan-a');
  expect(held).toBe(true);
  // The same view now shows plan B.
  unregisterA();
  const unregisterB = registerOpenPlan(projectId, 'plan-b', view);
  expect(held).toBe(false);
  hold.release();
  expect(held).toBe(false);
  unregisterB();
});
