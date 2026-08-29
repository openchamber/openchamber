import { expect, test } from 'bun:test';
import { ShortcutRegistry } from './registry';

test('the first registration wins and a later unregister cannot remove it', () => {
  const registry = new ShortcutRegistry();
  const firstHandler = () => undefined;
  const first = registry.register('open_settings', firstHandler);
  const replacement = registry.register('open_settings', () => false);

  replacement();

  expect(registry.get('open_settings')).toBe(firstHandler);
  first();
  expect(registry.get('open_settings')).toBe(undefined);
});

test('a later registration takes over after the first unregisters', () => {
  const registry = new ShortcutRegistry();
  const firstHandler = () => undefined;
  const secondHandler = () => false;
  const first = registry.register('open_settings', firstHandler);
  registry.register('open_settings', secondHandler);

  expect(registry.get('open_settings')).toBe(firstHandler);
  first();
  expect(registry.get('open_settings')).toBe(secondHandler);
});

test('suspends all handlers until every idempotent cleanup completes', () => {
  const registry = new ShortcutRegistry();
  const handler = () => undefined;
  registry.register('open_settings', handler);

  const resumeFirst = registry.suspend();
  const resumeSecond = registry.suspend();
  expect(registry.get('open_settings')).toBe(undefined);
  expect(registry.isSuspended()).toBe(true);

  resumeFirst();
  resumeFirst();
  expect(registry.get('open_settings')).toBe(undefined);
  resumeSecond();
  resumeSecond();
  expect(registry.get('open_settings')).toBe(handler);
  expect(registry.isSuspended()).toBe(false);
});
