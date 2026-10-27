import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';

import type { Part } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { OpenUISession, OpenUISessionProvider, useOpenUISession, useOpenUIFields, type PartLease } from './openuiSession';
import { KeepAlive } from '@/components/ui/KeepAlive';

const acquire = (session: OpenUISession, key: string, lease: PartLease) => {
  const field = session.field(key, lease);
  return { ...field, release: field.retain() };
};

const owner = { runtimeKey: 'runtime', directory: '/repo', sessionId: 'session' };
const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;

beforeEach(() => {
  const dom = new Window({ url: 'http://openui-session.test' });
  const values = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of globals) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  for (const name of globals) {
    const original = originals.get(name);
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('restores an opaque snapshot across an unmount', () => {
  const session = new OpenUISession(owner);
  const lease = session.trackPart('message', 'part', 'root = Stack([])');
  const first = acquire(session, 'field', lease);
  const saved = { changed: new Date('2026-01-02T03:04:05.000Z') };
  first.save(saved);
  first.release();

  const restored = acquire(session, 'field', lease);
  expect(restored.initialState).toEqual(saved);
  expect(restored.initialState).not.toBe(saved);
  restored.release();
});

test('a too-large draft drops its old snapshot instead of restoring stale values', () => {
  const session = new OpenUISession(owner);
  const lease = session.trackPart('message', 'part', 'source');
  const field = acquire(session, 'field', lease);
  expect(field.save({ value: 'earlier' })).toBe(true);
  expect(field.save({ value: '你'.repeat(30_000) })).toBe(false);
  expect(field.isCurrent()).toBe(true);
  field.release();
  expect(session.field('field', lease).initialState).toBeUndefined();
});

test('an uncloneable draft also clears the previous snapshot', () => {
  const session = new OpenUISession(owner);
  const lease = session.trackPart('message', 'part', 'source');
  const field = acquire(session, 'field', lease);
  expect(field.save({ value: 'earlier' })).toBe(true);
  expect(field.save({ value: () => {} })).toBe(false);
  field.release();
  expect(session.field('field', lease).initialState).toBeUndefined();
});

test('StrictMode lifecycle replay retains state but an actual observation gap disposes it', async () => {
  const session = new OpenUISession(owner);
  const initial = session.trackPart('message', 'part', 'source');
  const field = acquire(session, 'field', initial);
  field.save({ value: 'kept' });
  field.release();
  const releaseFirst = session.retain();
  releaseFirst?.();
  const releaseReplay = session.retain();
  await Promise.resolve();
  expect(initial.isCurrent()).toBe(true);
  expect(session.field('field', initial).initialState).toEqual({ value: 'kept' });
  releaseReplay?.();
  await Promise.resolve();
  expect(initial.isCurrent()).toBe(false);
  expect(session.trackPart('message', 'part', 'source').isCurrent()).toBe(false);
  expect(session.retain()).toBeNull();
});

test('keeps a strict append and retires a replaced source without ABA restoration', () => {
  const session = new OpenUISession(owner);
  const initial = session.trackPart('message', 'part', 'open');
  acquire(session, 'field', initial).save({ value: 'first' });

  const appended = session.trackPart('message', 'part', 'open more');
  expect(appended.generation).toBe(initial.generation);
  expect(session.field('field', appended).initialState).toEqual({ value: 'first' });

  session.reconcilePart('message', 'part', 'other');
  const replaced = session.trackPart('message', 'part', 'other');
  acquire(session, 'field', replaced).save({ value: 'second' });
  session.reconcilePart('message', 'part', 'open');
  const returned = session.trackPart('message', 'part', 'open');
  expect(returned.generation).toBeGreaterThan(replaced.generation);
  expect(session.field('field', returned).initialState).toBeUndefined();
});

test('does not let a stale render rewind an authoritative append', () => {
  const session = new OpenUISession(owner);
  const seeded = session.trackPart('message', 'part', 'A');
  const field = acquire(session, 'field', seeded);
  field.save({ value: 'kept' });
  field.release();

  session.reconcilePart('message', 'part', 'AB');
  const stale = session.trackPart('message', 'part', 'A');
  const current = session.trackPart('message', 'part', 'AB');

  expect(stale.isCurrent()).toBe(true);
  expect(stale.generation).toBe(seeded.generation);
  expect(current.generation).toBe(seeded.generation);
  expect(session.field('field', current).initialState).toEqual({ value: 'kept' });
});

test('only an authoritative shrink creates a new generation', () => {
  const session = new OpenUISession(owner);
  const initial = session.trackPart('message', 'part', 'AB');
  const abandoned = session.trackPart('message', 'part', 'C');
  expect(abandoned.isCurrent()).toBe(false);

  session.reconcilePart('message', 'part', 'A');
  const shrunk = session.trackPart('message', 'part', 'A');
  expect(shrunk.generation).toBeGreaterThan(initial.generation);
});

test('a reset or tracked part removal revokes an existing lease', () => {
  const session = new OpenUISession(owner);
  const lease = session.trackPart('message', 'part', 'source');
  expect(session.field('field', lease).isCurrent()).toBe(true);

  session.reset();
  expect(lease.isCurrent()).toBe(false);
});

test('keeps identical sources isolated by their message and part identity', () => {
  const session = new OpenUISession(owner);
  const first = session.trackPart('first-message', 'part', 'source');
  const second = session.trackPart('second-message', 'part', 'source');
  const firstField = acquire(session, 'shared-fence', first);
  firstField.save({ value: 'first' });
  firstField.release();

  expect(session.field('shared-fence', second).initialState).toBeUndefined();
});

test('equal message and generation keys in another runtime never share field handles', async () => {
  const initialStates: unknown[] = [];
  const first = new OpenUISession(owner);
  const second = new OpenUISession({ ...owner, runtimeKey: 'another-runtime' });
  const Probe = ({ session }: { session: OpenUISession }) => {
    const lease = session.trackPart('message', 'part', 'source');
    const field = useOpenUIFields('same-key', lease);
    React.useEffect(() => {
      initialStates.push(field?.initialState);
      field?.save({ value: session.owner.runtimeKey });
    }, [field, session]);
    return null;
  };
  await act(async () => root.render(<Probe session={first} />));
  await act(async () => root.render(<Probe session={second} />));
  expect(initialStates).toEqual([undefined, undefined]);
  expect(second.field('same-key', second.trackPart('message', 'part', 'source')).initialState)
    .toEqual({ value: 'another-runtime' });
});

test('reconciles only the notified message and keeps unrelated tracked parts current', () => {
  const session = new OpenUISession(owner);
  const changed = session.trackPart('changed', 'part', 'old');
  const unrelated = session.trackPart('unrelated', 'part', 'still-current');

  session.reconcileMessage('changed', [{ id: 'part', type: 'text', text: 'replacement', messageID: 'changed', sessionID: 'session' }]);

  expect(changed.isCurrent()).toBe(false);
  expect(unrelated.isCurrent()).toBe(true);
});

test('bounds idle entries and source ledgers without evicting active fields', () => {
  const session = new OpenUISession(owner);
  const lease = session.trackPart('message', 'part', 'source');
  const active = acquire(session, 'active', lease);
  active.save({ text: 'active' });

  for (let index = 0; index < 110; index += 1) {
    const field = acquire(session, `idle-${index}`, lease);
    field.save({ index });
    field.release();
  }
  for (let index = 0; index < 110; index += 1) {
    session.trackPart(`idle-message-${index}`, 'part', `source-${index}`);
  }
  session.trimIdle();

  expect(active.isCurrent()).toBe(true);
  active.release();
});

test('uncommitted field handles cannot save or consume the draft budget', async () => {
  const session = new OpenUISession(owner);
  const lease = session.trackPart('message', 'part', 'source');
  const active = acquire(session, 'active', lease);
  active.save({ value: 'kept' });
  for (let index = 0; index < 110; index += 1) {
    const field = session.field(`speculative-${index}`, lease);
    expect(field.save({ value: 'x'.repeat(20_000) })).toBe(false);
  }

  await Promise.resolve();
  session.trimIdle();

  active.release();
  expect(session.field('active', lease).initialState).toEqual({ value: 'kept' });
  expect(session.field('speculative-0', lease).initialState).toBeUndefined();
});

test('tracks only a direct prompt_openui tool source and revokes a rejected tool', () => {
  const session = new OpenUISession(owner);
  const prompt = session.trackPart('message', 'tool', 'root = Stack([])');
  const tool: Extract<Part, { type: 'tool' }> = {
    id: 'tool',
    sessionID: 'session',
    messageID: 'message',
    type: 'tool',
    callID: 'call',
    tool: 'prompt_openui',
    state: { status: 'running', input: { ui: 'root = Stack([])' }, time: { start: 0 } },
  };

  session.reconcileMessage('message', [tool]);
  expect(prompt.isCurrent()).toBe(true);

  session.reconcileMessage('message', [{
    ...tool,
    tool: 'execute',
    state: { status: 'pending', input: { ui: 'root = Stack([])' }, raw: '{"ui":"root = Stack([])"}' },
  }]);
  expect(prompt.isCurrent()).toBe(false);
});

test('retains one field through StrictMode replay and a real unmount', async () => {
  const session = new OpenUISession(owner);
  const initialStates: Array<unknown> = [];
  const Probe = () => {
    const lease = session.trackPart('message', 'part', 'source');
    const field = useOpenUIFields('message:part:fence', lease);
    React.useEffect(() => {
      initialStates.push(field?.initialState);
      if (field?.initialState === undefined) field?.save({ changed: new Date('2026-01-02T03:04:05.000Z') });
    }, [field]);
    return null;
  };

  await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));
  await act(async () => root.render(null));
  await act(async () => root.render(<React.StrictMode><Probe /></React.StrictMode>));

  expect(initialStates.some((state) => state instanceof Object && 'changed' in state)).toBe(true);
});

test('one mounted consumer protects a draft when another consumer unmounts', async () => {
  const session = new OpenUISession(owner);
  const lease = session.trackPart('message', 'part', 'source');
  const first = acquire(session, 'shared', lease);
  const second = acquire(session, 'shared', lease);
  first.save({ value: 'kept' });
  first.release();
  for (let index = 0; index < 110; index++) {
    const idle = acquire(session, `idle-${index}`, lease);
    idle.save({ index });
    idle.release();
  }
  session.trimIdle();
  expect(session.field('shared', lease).initialState).toEqual({ value: 'kept' });
  second.release();
});

test('retained timelines recreate their own source owner after an Activity observation gap', async () => {
  const sdk = OpenCode.make({
    baseUrl: 'https://openui-session.test',
    fetch: async () => Response.json({ data: [] }),
  });
  const owners = new Map<string, OpenUISession>();
  const leases = new Map<string, PartLease>();
  function Probe() {
    const session = useOpenUISession();
    if (session) {
      owners.set(session.owner.sessionId, session);
      leases.set(session.owner.sessionId, session.trackPart('message', 'part', 'source'));
    }
    return null;
  }
  const render = (sessionId: string) => act(async () => root.render(
    <SyncProvider sdk={sdk} directory="">
      <KeepAlive cacheKey={sessionId} capacity={2}>
        <OpenUISessionProvider sessionId={sessionId} directory="/repo">
          <Probe />
        </OpenUISessionProvider>
      </KeepAlive>
    </SyncProvider>,
  ));

  await render('first');
  const firstOwner = owners.get('first');
  const firstLease = leases.get('first');
  expect(firstLease?.isCurrent()).toBe(true);
  await render('second');
  expect(firstLease?.isCurrent()).toBe(false);
  expect(owners.get('second')?.owner.sessionId).toBe('second');
  await render('first');
  expect(owners.get('first')).not.toBe(firstOwner);
  expect(owners.get('first')?.owner.sessionId).toBe('first');
  expect(leases.get('first')?.isCurrent()).toBe(true);
  expect(firstLease?.isCurrent()).toBe(false);
});
