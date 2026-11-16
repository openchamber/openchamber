import { describe, expect, test } from 'bun:test';

import { markSeen, noteOwnChanges, traceChanges, traceTableRows } from './cellTraces';

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

  test('an own workbook edit preserves the marks of outside changes', () => {
    traceChanges('c', cells({ x: '1', y: '1' }));
    traceChanges('c', cells({ x: '1', y: '2' }));
    noteOwnChanges('c', [['x', '5']]);
    expect([...traceChanges('c', cells({ x: '5', y: '2' }))]).toEqual(['y']);
  });

  test('workbook cell patches and structure replacements move the baseline', () => {
    traceChanges('workbook-patches', cells({ '0:1:1': 'a', '0:1:2': 'b' }));
    noteOwnChanges('workbook-patches', [['0:1:1', 'edited'], ['0:1:2', null]]);
    expect(traceChanges('workbook-patches', cells({ '0:1:1': 'edited' })).size).toBe(0);
    noteOwnChanges('workbook-patches', [['0:2:1', 'moved']], true);
    expect(traceChanges('workbook-patches', cells({ '0:2:1': 'moved' })).size).toBe(0);
  });
});

describe('CSV row snapshots', () => {
  test('first views and own edits do not read every cell to build the baseline', () => {
    let reads = 0;
    const row = ['value'];
    Object.defineProperty(row, 0, {
      get: () => {
        reads += 1;
        return 'value';
      },
    });
    traceTableRows('rows-baseline-cost', [row]);
    expect(reads).toBe(0);
    traceTableRows('rows-baseline-cost', [row], true);
    expect(reads).toBe(0);
  });

  test('the first look and a reopen with the same values mark nothing', () => {
    expect(traceTableRows('rows-first-look', [['', 'a'], []]).size).toBe(0);
    expect(traceTableRows('rows-first-look', [['', 'a'], []]).size).toBe(0);
  });

  test('outside changes survive a reopen and clear only when seen', () => {
    traceTableRows('rows-outside', [['', 'a'], ['gone']]);
    const changed = [['new', ''], ['', 'added']];
    const keys = ['0:0', '0:1', '1:0', '1:1'];
    expect([...traceTableRows('rows-outside', changed)]).toEqual(keys);
    expect([...traceTableRows('rows-outside', [['new', ''], ['', 'added']])]).toEqual(keys);
    expect([...markSeen('rows-outside', ['0:0', '0:1'])]).toEqual(['1:0', '1:1']);
    expect([...traceTableRows('rows-outside', changed)]).toEqual(['1:0', '1:1']);
    markSeen('rows-outside', ['1:0', '1:1']);
    expect([...traceTableRows('rows-outside', [['new', '']])]).toEqual(['1:0', '1:1']);
  });

  test('adding and removing an empty field are changes', () => {
    traceTableRows('rows-empty-field', [[]]);
    expect([...traceTableRows('rows-empty-field', [['']])]).toEqual(['0:0']);
    markSeen('rows-empty-field', ['0:0']);
    expect([...traceTableRows('rows-empty-field', [[]])]).toEqual(['0:0']);
  });

  test('own edits update row values and shape without dropping unseen marks', () => {
    traceTableRows('rows-own-edit', [['original']]);
    traceTableRows('rows-own-edit', [['outside']]);
    expect([...traceTableRows('rows-own-edit', [['own', 'new field']], true)]).toEqual(['0:0']);
    markSeen('rows-own-edit', ['0:0']);
    expect(traceTableRows('rows-own-edit', [['own', 'new field']]).size).toBe(0);
    expect([...traceTableRows('rows-own-edit', [])]).toEqual(['0:0', '0:1']);
  });
});
