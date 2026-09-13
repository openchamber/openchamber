import { describe, expect, test } from 'bun:test';

import { resolveAgentAvailability } from './agentAvailability';

const directoryAgents = [
  { name: 'build' },
  { name: 'orchestrator' },
];

describe('resolveAgentAvailability', () => {
  test('keeps a requested agent the directory list contains', () => {
    expect(resolveAgentAvailability('orchestrator', directoryAgents)).toEqual({
      agent: 'orchestrator',
      reason: 'available',
    });
  });

  test('drops a requested agent the loaded directory list does not contain', () => {
    expect(resolveAgentAvailability('missing-agent', directoryAgents)).toEqual({
      reason: 'missing',
    });
  });

  test('reports missing against a loaded-but-empty list', () => {
    expect(resolveAgentAvailability('build', [])).toEqual({ reason: 'missing' });
  });

  test('treats an unloaded directory list as unknown and keeps the request', () => {
    expect(resolveAgentAvailability('orchestrator', undefined)).toEqual({
      agent: 'orchestrator',
      reason: 'unknown',
    });
    expect(resolveAgentAvailability('orchestrator', null)).toEqual({
      agent: 'orchestrator',
      reason: 'unknown',
    });
  });

  test('treats no requested agent as unknown', () => {
    expect(resolveAgentAvailability(undefined, directoryAgents)).toEqual({ reason: 'unknown' });
    expect(resolveAgentAvailability('   ', directoryAgents)).toEqual({ reason: 'unknown' });
  });

  test('trims the requested name before matching', () => {
    expect(resolveAgentAvailability('  build  ', directoryAgents)).toEqual({
      agent: 'build',
      reason: 'available',
    });
  });
});
