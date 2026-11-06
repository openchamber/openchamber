import { describe, expect, test } from 'bun:test';

import { markSeen, noteOwnEdit, traceChanges } from './cellTraces';

const cells = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('marks of outside changes', () => {
  test('the first look marks nothing and looking twice changes nothing', () => {
    expect(traceChanges('a', cells({ x: '1' })).size).toBe(0);
    expect(traceChanges('a', cells({ x: '1' })).size).toBe(0);
  });

  test('an unseen mark survives the next change and a reopen, until it is seen', () => {
    traceChanges('b', cells({ x: '1', y: '1' }));
    traceChanges('b', cells({ x: '2', y: '1' }));
    expect([...traceChanges('b', cells({ x: '2', y: '2' }))]).toEqual(['x', 'y']);
    expect([...traceChanges('b', cells({ x: '2', y: '2' }))]).toEqual(['x', 'y']);
    expect([...markSeen('b', ['x'])]).toEqual(['y']);
    expect([...traceChanges('b', cells({ x: '2', y: '2' }))]).toEqual(['y']);
  });

  test('an own edit marks nothing', () => {
    traceChanges('c', cells({ x: '1' }));
    noteOwnEdit('c', cells({ x: '5' }));
    expect(traceChanges('c', cells({ x: '5' })).size).toBe(0);
  });
});
