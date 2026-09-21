import { describe, expect, test } from 'bun:test';
import { ShortcutDispatcher } from './dispatcher';
import { ShortcutRegistry } from './registry';

function key(key: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    code: `Key${key.toUpperCase()}`,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...options,
  } as KeyboardEvent;
}

describe('ShortcutDispatcher', () => {
  test('dispatches a sequence and consumes only leaders with active handlers', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    const unregister = registry.register('open_command_palette', (event) => {
      calls.push(event.key);
    });
    const dispatcher = new ShortcutDispatcher({
      registry,
      getBinding: (id) => id === 'open_command_palette' ? 'g h' : '',
    });

    expect(dispatcher.dispatch(key('g'))).toBe(true);
    expect(dispatcher.dispatch(key('h'))).toBe(true);
    expect(calls).toEqual(['h']);

    unregister();
    expect(dispatcher.dispatch(key('g'))).toBe(false);
  });

  test('re-matches a prefix mismatch and clears on escape or blur', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_command_palette', () => { calls.push('sequence'); });
    registry.register('open_help', () => { calls.push('single'); });
    const dispatcher = new ShortcutDispatcher({
      registry,
      getBinding: (id) => id === 'open_command_palette' ? 'g h' : 'x',
    });

    dispatcher.dispatch(key('g'));
    expect(dispatcher.dispatch(key('x'))).toBe(true);
    expect(calls).toEqual(['single']);
    dispatcher.dispatch(key('g'));
    expect(dispatcher.dispatch(key('Escape'))).toBe(true);
    expect(dispatcher.handleEscape()).toBe(false);
    dispatcher.dispatch(key('g'));
    dispatcher.handleBlur();
    expect(dispatcher.dispatch(key('h'))).toBe(false);
  });

  test('expires prefixes and ignores repeats, composition, and modifier keys', () => {
    let now = 0;
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_command_palette', () => { calls.push('sequence'); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'g h', now: () => now });

    expect(dispatcher.dispatch(key('g'))).toBe(true);
    now = 2999;
    expect(dispatcher.hasActivePrefix()).toBe(true);
    now = 3000;
    expect(dispatcher.dispatch(key('h'))).toBe(false);
    expect(dispatcher.dispatch(key('g', { repeat: true }))).toBe(false);
    expect(dispatcher.dispatch(key('g', { isComposing: true }))).toBe(false);
    expect(dispatcher.dispatch(key('Shift'))).toBe(false);
    expect(calls).toEqual([]);
  });

  test('does not consume a completed binding when every handler declines it', () => {
    const registry = new ShortcutRegistry();
    registry.register('open_command_palette', () => false);
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'g h' });

    expect(dispatcher.dispatch(key('g'))).toBe(true);
    expect(dispatcher.dispatch(key('h'))).toBe(false);
  });

  test('does not consume a single chord when its handler declines it', () => {
    const registry = new ShortcutRegistry();
    registry.register('open_command_palette', () => false);
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'x' });

    expect(dispatcher.dispatch(key('x'))).toBe(false);
  });

  test('starts a sequence when a single-chord handler with the same leader declines', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('save_file', () => false);
    registry.register('open_draft_project_picker', () => { calls.push('project'); });
    const dispatcher = new ShortcutDispatcher({
      registry,
      getBinding: (id) => id === 'save_file' ? 'mod+s' : 'mod+s p',
    });

    expect(dispatcher.dispatch(key('s', { ctrlKey: true }))).toBe(true);
    expect(dispatcher.dispatch(key('p'))).toBe(true);
    expect(calls).toEqual(['project']);
  });

  test('does not start a sequence when a single-chord handler accepts the leader', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('save_file', () => { calls.push('save'); });
    registry.register('open_draft_project_picker', () => { calls.push('project'); });
    const dispatcher = new ShortcutDispatcher({
      registry,
      getBinding: (id) => id === 'save_file' ? 'mod+s' : 'mod+s p',
    });

    expect(dispatcher.dispatch(key('s', { ctrlKey: true }))).toBe(true);
    expect(dispatcher.dispatch(key('p'))).toBe(false);
    expect(calls).toEqual(['save']);
  });

  test('resolves bindings at dispatch time', () => {
    const registry = new ShortcutRegistry();
    let binding = 'x';
    const calls: string[] = [];
    registry.register('open_command_palette', (event) => { calls.push(event.key); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => binding });

    expect(dispatcher.dispatch(key('x'))).toBe(true);
    binding = 'y';
    expect(dispatcher.dispatch(key('x'))).toBe(false);
    expect(dispatcher.dispatch(key('y'))).toBe(true);
    expect(calls).toEqual(['x', 'y']);
  });

  test('invalidates a prefix when shortcut suspension changes', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_command_palette', () => { calls.push('sequence'); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'g h' });

    expect(dispatcher.dispatch(key('g'))).toBe(true);
    const resume = registry.suspend();
    expect(dispatcher.hasActivePrefix()).toBe(false);
    expect(dispatcher.handleEscape()).toBe(false);
    resume();
    expect(dispatcher.dispatch(key('h'))).toBe(false);
    expect(calls).toEqual([]);
  });

  test('marks a second key dispatched from capture so bubble does not dispatch it again', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_command_palette', () => { calls.push('sequence'); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'g h' });
    const secondKey = key('h');

    dispatcher.dispatch(key('g'));
    expect(dispatcher.dispatchActivePrefix(secondKey)).toBe(true);
    expect(dispatcher.consumeCapturedPrefixEvent(secondKey)).toBe(true);
    expect(dispatcher.consumeCapturedPrefixEvent(secondKey)).toBe(false);
    expect(calls).toEqual(['sequence']);
  });

  test('consumes a matching captured prefix key during IME composition', () => {
    for (const compositionState of [{ isComposing: true }, { keyCode: 229 }]) {
      const registry = new ShortcutRegistry();
      const calls: string[] = [];
      registry.register('open_session_list', () => { calls.push('sequence'); });
      const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'mod+s l' });
      const secondKey = key('l', compositionState);

      expect(dispatcher.dispatch(key('s', { ctrlKey: true }))).toBe(true);
      expect(dispatcher.dispatchActivePrefix(secondKey)).toBe(true);
      expect(dispatcher.consumeCapturedPrefixEvent(secondKey)).toBe(true);
      expect(calls).toEqual(['sequence']);
    }
  });

  test('clears an active prefix but preserves an unmatched IME key', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_session_list', () => { calls.push('sequence'); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'mod+s l' });
    const secondKey = key('x', { isComposing: true });

    dispatcher.dispatch(key('s', { ctrlKey: true }));
    expect(dispatcher.dispatchActivePrefix(secondKey)).toBe(false);
    expect(dispatcher.hasActivePrefix()).toBe(false);
    expect(calls).toEqual([]);
  });

  test('stops after the first handler that accepts a conflicting binding', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_command_palette', () => { calls.push('declined'); return false; });
    registry.register('open_help', () => { calls.push('first'); });
    registry.register('open_settings', () => { calls.push('second'); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'x' });

    expect(dispatcher.dispatch(key('x'))).toBe(true);
    expect(calls).toEqual(['declined', 'first']);
  });
});
