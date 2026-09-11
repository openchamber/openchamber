import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_STATES,
  assertObservedTransition,
  canReachObservedState,
  isWorkspaceState,
  nextObservedStates,
} from './state-machine.js';

describe('workspace state machine (plan section 8.2)', () => {
  it('covers exactly the diagram states', () => {
    expect(Object.values(WORKSPACE_STATES).sort()).toEqual(
      ['error', 'running', 'starting', 'stopped', 'stopping'].sort(),
    );
  });

  it('allows every diagram transition', () => {
    for (const [from, to] of [
      ['stopped', 'starting'],
      ['starting', 'running'],
      ['starting', 'error'],
      ['running', 'stopping'],
      ['stopping', 'stopped'],
      ['stopping', 'error'],
      ['error', 'starting'],
      ['error', 'stopped'],
    ]) {
      expect(canReachObservedState(from, to)).toBe(true);
    }
  });

  it('allows stopping a still-starting environment (plan section 8.5)', () => {
    expect(canReachObservedState('starting', 'stopping')).toBe(true);
  });

  it('rejects backwards and invalid jumps', () => {
    for (const [from, to] of [
      ['running', 'stopped'],
      ['running', 'starting'],
      ['running', 'error'], // only stopping may fail into error
      ['starting', 'stopped'], // must fail into error, never wedge silently
      ['stopped', 'running'],
      ['stopped', 'error'],
      ['error', 'running'],
      ['stopping', 'starting'],
      ['bogus', 'stopped'],
      ['stopped', 'bogus'],
    ]) {
      expect(canReachObservedState(from, to)).toBe(false);
      expect(() => assertObservedTransition(from, to)).toThrow(/invalid workspace observed_state transition/);
    }
  });

  it('treats identity as reachable so concurrent operations may re-assert a state', () => {
    expect(canReachObservedState('starting', 'starting')).toBe(true);
    expect(canReachObservedState('stopped', 'stopped')).toBe(true);
  });

  it('exposes next states and validates membership', () => {
    expect(nextObservedStates('starting').sort()).toEqual(['error', 'running', 'stopping']);
    expect(nextObservedStates('stopped')).toEqual(['starting']);
    expect(nextObservedStates('nope')).toEqual([]);
    expect(isWorkspaceState('stopping')).toBe(true);
    expect(isWorkspaceState('paused')).toBe(false);
  });
});
