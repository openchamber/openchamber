import { describe, expect, test } from 'bun:test';
import { createSseDataParser } from './sse-data-parser';

describe('createSseDataParser', () => {
  test('parses arbitrary chunk boundaries and multiple line ending styles', () => {
    const frames: string[] = [];
    const parser = createSseDataParser((data) => frames.push(data));

    for (const chunk of ['da', 'ta: one\r', '\n\r', '\ndata: two\r\r', 'data: three\n\n']) {
      parser.push(chunk);
    }

    expect(frames).toEqual(['one', 'two', 'three']);
  });

  test('joins multiline data and removes at most one optional space', () => {
    const frames: string[] = [];
    const parser = createSseDataParser((data) => frames.push(data));

    parser.push('data:first\ndata: second\ndata:  third\n\n');

    expect(frames).toEqual(['first\nsecond\n third']);
  });

  test('dispatches empty data and ignores non-data fields and comments', () => {
    const frames: string[] = [];
    const parser = createSseDataParser((data) => frames.push(data));

    parser.push(': comment\nevent: named\nid: 1\nretry: 1000\ndata:\n\n');

    expect(frames).toEqual(['']);
  });

  test('does not dispatch an incomplete event on EOF', () => {
    const frames: string[] = [];
    const parser = createSseDataParser((data) => frames.push(data));

    parser.push('data: incomplete\n');
    parser.end();

    expect(frames).toEqual([]);
  });

  test('throws when a persistent unterminated line exceeds its code-unit limit', () => {
    const parser = createSseDataParser(() => {}, {
      maxUnterminatedLineCodeUnits: 4,
      maxPendingEventDataCodeUnits: 20,
    });

    parser.push('data');
    expect(() => parser.push(':')).toThrow('unterminated line');
  });

  test('throws when multiline pending event data exceeds its aggregate limit', () => {
    const parser = createSseDataParser(() => {}, {
      maxUnterminatedLineCodeUnits: 20,
      maxPendingEventDataCodeUnits: 5,
    });

    parser.push('data: ab\n');
    expect(() => parser.push('data: cde\n')).toThrow('pending event data');
  });

  test('accepts exact line and pending-event code-unit boundaries', () => {
    const frames: string[] = [];
    const parser = createSseDataParser((data) => frames.push(data), {
      maxUnterminatedLineCodeUnits: 8,
      maxPendingEventDataCodeUnits: 5,
    });

    parser.push('data: ab');
    parser.push('\ndata: cd\n\n');

    expect(frames).toEqual(['ab\ncd']);
  });

  test('continues parsing normal chunks with small limits', () => {
    const frames: string[] = [];
    const parser = createSseDataParser((data) => frames.push(data), {
      maxUnterminatedLineCodeUnits: 16,
      maxPendingEventDataCodeUnits: 8,
    });

    parser.push('data: one\n\ndata: ');
    parser.push('two\n\n');

    expect(frames).toEqual(['one', 'two']);
  });

  for (const invalidLimit of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
    test(`rejects invalid unterminated-line limit ${String(invalidLimit)}`, () => {
      expect(() => createSseDataParser(() => {}, {
        maxUnterminatedLineCodeUnits: invalidLimit,
        maxPendingEventDataCodeUnits: 1,
      })).toThrow('finite non-negative integers');
    });

    test(`rejects invalid pending-event limit ${String(invalidLimit)}`, () => {
      expect(() => createSseDataParser(() => {}, {
        maxUnterminatedLineCodeUnits: 1,
        maxPendingEventDataCodeUnits: invalidLimit,
      })).toThrow('finite non-negative integers');
    });
  }
});
