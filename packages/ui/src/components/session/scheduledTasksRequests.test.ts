import { describe, expect, test } from 'bun:test';

import { createTaskRequestGate, mayCommitTaskList, mayEndTaskLoad } from './scheduledTasksRequests';

describe('scheduled task request gate', () => {
  test('a slow older response for the same project is dropped', () => {
    const gate = createTaskRequestGate();
    const first = gate.begin('a');
    const second = gate.begin('a');
    // The second fetch answers first, then the first one arrives late.
    expect(gate.isLatest('a', second)).toBe(true);
    expect(gate.isLatest('a', first)).toBe(false);
  });

  test('requests of different projects do not supersede each other', () => {
    const gate = createTaskRequestGate();
    const a = gate.begin('a');
    const b = gate.begin('b');
    expect(gate.isLatest('a', a)).toBe(true);
    expect(gate.isLatest('b', b)).toBe(true);
  });

  test('switching A to B to C leaves only C on screen, in any response order', () => {
    const gate = createTaskRequestGate();
    const requests = { a: gate.begin('a'), b: gate.begin('b'), c: gate.begin('c') };
    const selected = 'c';
    for (const projectID of ['b', 'c', 'a'] as const) {
      const lands = gate.isLatest(projectID, requests[projectID]) && mayCommitTaskList(projectID, selected);
      expect(lands).toBe(projectID === 'c');
    }
  });

  test('a response for another scope never ends the spinner of the scope on screen', () => {
    const gate = createTaskRequestGate();
    const a = gate.begin('a');
    const b = gate.begin('b');
    expect(mayEndTaskLoad(gate, 'a', a, 'b')).toBe(false);
    expect(mayEndTaskLoad(gate, 'b', b, 'b')).toBe(true);
  });

  test('only the newest load of the scope on screen ends its spinner', () => {
    const gate = createTaskRequestGate();
    const first = gate.begin('a');
    const second = gate.begin('a');
    expect(mayEndTaskLoad(gate, 'a', first, 'a')).toBe(false);
    expect(mayEndTaskLoad(gate, 'a', second, 'a')).toBe(true);
  });

  test('the empty scope may always commit its empty list', () => {
    expect(mayCommitTaskList('', 'a')).toBe(true);
  });
});
