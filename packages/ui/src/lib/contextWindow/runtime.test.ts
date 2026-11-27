import { expect, test } from 'bun:test';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { contextWindowMatchesRuntime, contextWindowRuntimeArgs } from './runtime';

test('a detached window can take a verified direct route for the saved host its owner reaches through relay', () => {
  switchRuntimeEndpoint({
    apiBaseUrl: 'http://localhost:1',
    runtimeKey: 'host:project-server',
    requestHeaders: { 'X-Fixture-Route': 'test' },
  });
  expect(contextWindowMatchesRuntime('host:project-server')).toBe(true);
  expect(contextWindowMatchesRuntime('host:another-server')).toBe(false);
  expect(contextWindowRuntimeArgs()).toMatchObject({
    apiBaseUrl: 'http://localhost:1',
    runtimeKey: '',
    requestHeaders: { 'X-Fixture-Route': 'test' },
  });
});
