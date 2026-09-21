import { expect, test } from 'bun:test';
import type { ShortcutHandler } from '@/lib/shortcuts';
import type { ShortcutBindings } from './useKeybind';

const handler: ShortcutHandler = () => {};
const validBindings = {
  open_session_list: handler,
};
const mixedBindingsWithTypo = {
  open_session_list: handler,
  open_session_lsit: handler,
};

const acceptedBindings: ShortcutBindings<typeof validBindings> = validBindings;
// @ts-expect-error A misspelled key must fail even when the object also contains a valid ID.
const rejectedBindings: ShortcutBindings<typeof mixedBindingsWithTypo> = mixedBindingsWithTypo;
void rejectedBindings;

test('accepts bindings whose IDs are declared in the shortcut schema', () => {
  expect(Object.keys(acceptedBindings)).toEqual(['open_session_list']);
});
