import { describe, expect, test } from 'bun:test';
import type { GuestStatusControl, GuestStatusControlEvent } from '@openchamber/sdk';
import { createGuestStatusControls, type GuestStatusControlBinding } from './status-controls';

const definitions: GuestStatusControl[] = [
  { kind: 'button', id: 'refresh', label: 'Refresh' },
  { kind: 'select', id: 'mode', label: 'History', value: 'auto', options: [
    { value: 'auto', label: 'Auto' }, { value: 'all', label: 'All' },
  ] },
];

const fixture = () => {
  const bindings: Array<GuestStatusControlBinding | null> = [];
  const events: GuestStatusControlEvent[] = [];
  let active = true;
  let time = 1000;
  let context = '/a';
  const channel = createGuestStatusControls({
    isActive: () => active, onChange: (value) => bindings.push(value),
    post: (event) => events.push(event), now: () => time,
    getContext: () => context,
  });
  const current = () => {
    const binding = bindings.at(-1);
    if (!binding) throw new Error('Expected an active header binding');
    return binding;
  };
  return { channel, bindings, events, current, revoke: () => { active = false; }, advance: () => { time += 1000; }, switchContext: () => { context = '/b'; } };
};

describe('guest-owned status control lifetime', () => {
  test('retires only header ownership on project changes and accepts identical republished controls', () => {
    const f = fixture();
    f.channel.set(definitions);
    const old = f.current();
    f.switchContext();
    old.dispatch({ id: 'refresh' });
    expect(f.events).toHaveLength(0);
    f.channel.retire();
    expect(f.bindings.at(-1)).toBeNull();
    f.channel.set(definitions);
    f.current().dispatch({ id: 'refresh' });
    expect(f.events).toEqual([{ id: 'refresh' }]);
    old.dispatch({ id: 'refresh' });
    expect(f.events).toHaveLength(1);
  });

  test('forwards only valid enabled actions from the current definition', () => {
    const f = fixture();
    f.channel.set(definitions);
    f.current().dispatch({ id: 'refresh' });
    f.current().dispatch({ id: 'mode', value: 'all' });
    f.current().dispatch({ id: 'refresh', value: 'all' });
    f.current().dispatch({ id: 'mode', value: 'unknown' });
    f.current().dispatch({ id: 'unknown' });
    expect(f.events).toEqual([{ id: 'refresh' }, { id: 'mode', value: 'all' }]);
    f.channel.set([{ kind: 'button', id: 'refresh', label: 'Refresh', disabled: true }]);
    f.current().dispatch({ id: 'refresh' });
    expect(f.events).toHaveLength(2);
  });

  test('retired bindings cannot dispatch after replacement, withdrawal or teardown', () => {
    const f = fixture();
    f.channel.set(definitions);
    const old = f.current();
    f.channel.set([{ kind: 'button', id: 'refresh', label: 'Refresh again' }]);
    old.dispatch({ id: 'refresh' });
    expect(f.events).toHaveLength(0);
    const live = f.current();
    f.revoke();
    live.dispatch({ id: 'refresh' });
    expect(() => f.channel.set(definitions)).toThrow();
    f.channel.dispose();
    live.dispatch({ id: 'refresh' });
    expect(f.events).toHaveLength(0);
    expect(f.bindings.at(-1)).toBeNull();
  });

  test('coalesces equivalent definitions and bounds changed publications without retry timers', () => {
    const f = fixture();
    f.channel.set(definitions);
    for (let i = 0; i < 100; i += 1) f.channel.set(definitions.map((control) => ({ ...control })));
    expect(f.bindings).toHaveLength(1);
    for (let i = 1; i < 20; i += 1) f.channel.set([{ kind: 'button', id: 'refresh', label: `Refresh ${i}` }]);
    const current = f.current();
    expect(() => f.channel.set(definitions)).toThrow();
    expect(f.current()).toBe(current);
    f.advance();
    f.channel.set(definitions);
    expect(f.current().controls).toEqual(definitions);
    f.channel.set([]);
    expect(f.bindings.at(-1)).toBeNull();
    current.dispatch({ id: 'refresh' });
    expect(f.events).toHaveLength(0);
  });
});
