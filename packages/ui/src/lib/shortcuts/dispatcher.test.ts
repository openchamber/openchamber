import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { ShortcutDispatcher } from './dispatcher';
import { ShortcutRegistry } from './registry';
import { getEffectiveShortcutCombo, UNASSIGNED_SHORTCUT } from './index';

const previousKeyboardEvent = Object.getOwnPropertyDescriptor(globalThis, 'KeyboardEvent');
Object.defineProperty(globalThis, 'KeyboardEvent', {
  value: new Window().KeyboardEvent, configurable: true, writable: true,
});
afterAll(() => {
  if (previousKeyboardEvent) Object.defineProperty(globalThis, 'KeyboardEvent', previousKeyboardEvent);
  else Reflect.deleteProperty(globalThis, 'KeyboardEvent');
});

const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const withUserAgent = <T,>(userAgent: string, run: () => T): T => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent }, configurable: true, writable: true,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
};

function key(key: string, options: KeyboardEventInit & { keyCode?: number } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key, code: `Key${key.toUpperCase()}`, cancelable: true, ...options,
  });
  Object.defineProperty(event, 'keyCode', { value: options.keyCode ?? 0 });
  return event;
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

  test('history is consumed at a boundary but leaves prevented, composed and AltGraph input alone', () => {
    const registry = new ShortcutRegistry();
    let calls = 0;
    registry.register('navigate_session_back', () => { calls += 1; });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'ctrl+[' });
    const event = (extra: KeyboardEventInit = {}) => new KeyboardEvent('keydown', {
      key: '[', code: 'BracketLeft', ctrlKey: true, cancelable: true, ...extra,
    });
    expect(dispatcher.dispatch(event())).toBe(true);
    expect(calls).toBe(1);
    const consumed = event();
    consumed.preventDefault();
    expect(dispatcher.dispatch(consumed)).toBe(false);
    expect(dispatcher.dispatch(event({ isComposing: true }))).toBe(false);
    class AltGraphEvent extends KeyboardEvent {
      override getModifierState(key: string): boolean {
        return key === 'AltGraph' || super.getModifierState(key);
      }
    }
    registry.register('cycle_favorite_model_backward', () => { calls += 1; });
    const modelDispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'ctrl+alt+[' });
    const altGraph = new AltGraphEvent('keydown', { key: '[', code: 'BracketLeft', ctrlKey: true, altKey: true });
    expect(modelDispatcher.dispatch(altGraph)).toBe(false);
    const resume = registry.suspend();
    expect(dispatcher.dispatch(event())).toBe(false);
    resume();
    expect(calls).toBe(1);
  });

  test('real platform defaults and a saved assignment dispatch at most one command', () => {
    type Row = {
      name: string;
      overrides: Record<string, string>;
      platform: 'macos' | 'other';
      event: KeyboardEventInit;
      expected: string[];
      altGraph?: boolean;
      prevented?: boolean;
    };
    const actions = ['navigate_session_back', 'navigate_session_forward',
      'cycle_favorite_model_backward', 'cycle_favorite_model_forward'] as const;
    const rows: Row[] = [
      { name: 'other default back', overrides: {}, platform: 'other',
        event: { key: '[', code: 'BracketLeft', ctrlKey: true }, expected: ['navigate_session_back'] },
      { name: 'other default forward', overrides: {}, platform: 'other',
        event: { key: ']', code: 'BracketRight', ctrlKey: true }, expected: ['navigate_session_forward'] },
      { name: 'other model cycle', overrides: {}, platform: 'other',
        event: { key: '[', code: 'BracketLeft', ctrlKey: true, altKey: true }, expected: ['cycle_favorite_model_backward'] },
      { name: 'other saved model keeps its chord', overrides: { cycle_favorite_model_backward: 'mod+[' }, platform: 'other',
        event: { key: '[', code: 'BracketLeft', ctrlKey: true }, expected: ['cycle_favorite_model_backward'] },
      { name: 'other saved model leaves forward default', overrides: { cycle_favorite_model_backward: 'mod+[' }, platform: 'other',
        event: { key: ']', code: 'BracketRight', ctrlKey: true }, expected: ['navigate_session_forward'] },
      { name: 'unassigned history is inert', overrides: { navigate_session_back: UNASSIGNED_SHORTCUT }, platform: 'other',
        event: { key: '[', code: 'BracketLeft', ctrlKey: true }, expected: [] },
      { name: 'other altgr never cycles models', overrides: {}, platform: 'other',
        event: { key: '[', code: 'BracketLeft', ctrlKey: true, altKey: true }, expected: [], altGraph: true },
      { name: 'an editor-consumed chord is not stolen', overrides: {}, platform: 'other',
        event: { key: '[', code: 'BracketLeft', ctrlKey: true }, expected: [], prevented: true },
      { name: 'mac default back uses cmd', overrides: {}, platform: 'macos',
        event: { key: '[', code: 'BracketLeft', metaKey: true }, expected: ['navigate_session_back'] },
      { name: 'mac ctrl chord stays with models', overrides: {}, platform: 'macos',
        event: { key: '[', code: 'BracketLeft', ctrlKey: true }, expected: ['cycle_favorite_model_backward'] },
      { name: 'mac saved model suppresses the history default', overrides: { cycle_favorite_model_backward: 'mod+[' }, platform: 'macos',
        event: { key: '[', code: 'BracketLeft', metaKey: true }, expected: ['cycle_favorite_model_backward'] },
    ];

    const dispatchRow = (row: Row) => {
      const registry = new ShortcutRegistry();
      const invoked: string[] = [];
      for (const id of actions) registry.register(id, () => { invoked.push(id); });
      const dispatcher = new ShortcutDispatcher({
        registry,
        getBinding: (actionId) => getEffectiveShortcutCombo(actionId, row.overrides, row.platform),
      });
      // happy-dom reports AltGraph for every altKey event; a real browser reports
      // it only for AltGr, so the row states the modifier explicitly.
      class RowEvent extends KeyboardEvent {
        override getModifierState(key: string): boolean {
          return key === 'AltGraph' ? row.altGraph === true : super.getModifierState(key);
        }
      }
      const event = new RowEvent('keydown', { cancelable: true, ...row.event });
      if (row.prevented) event.preventDefault();
      const consumed = dispatcher.dispatch(event);
      return { invoked, consumed };
    };

    for (const platform of ['other', 'macos'] as const) {
      withUserAgent(platform === 'macos' ? MAC_USER_AGENT : 'Bun/1.3.10', () => {
        for (const row of rows.filter((entry) => entry.platform === platform)) {
          const outcome = dispatchRow(row);
          expect({ name: row.name, invoked: outcome.invoked })
            .toEqual({ name: row.name, invoked: row.expected });
          expect(outcome.invoked.length).toBeLessThanOrEqual(1);
        }
      });
    }
  });
});
