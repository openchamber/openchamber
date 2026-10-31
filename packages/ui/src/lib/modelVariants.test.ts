import { describe, expect, test } from 'bun:test';
import { formatVariantLabel, listModelVariantIds, modelVariantNames } from './modelVariants';

describe('listModelVariantIds', () => {
  test('reads ids from the OpenCode 2 array, not array indices', () => {
    const variants = [{ id: 'none' }, { id: 'low' }, { id: 'high' }];
    expect(listModelVariantIds(variants)).toEqual(['none', 'low', 'high']);
  });

  test('reads keys from the v1 record', () => {
    expect(listModelVariantIds({ low: {}, high: {} })).toEqual(['low', 'high']);
  });

  test('is empty for a model without variants', () => {
    expect(listModelVariantIds(undefined)).toEqual([]);
    expect(modelVariantNames(undefined)).toEqual([]);
    expect(modelVariantNames({})).toEqual([]);
  });
});

describe('formatVariantLabel', () => {
  test('capitalizes the id the way the composer shows it', () => {
    expect(formatVariantLabel('max')).toBe('Max');
    expect(formatVariantLabel('xhigh')).toBe('Xhigh');
    expect(formatVariantLabel('  low ')).toBe('Low');
  });

  test('keeps a numeric id as written', () => {
    expect(formatVariantLabel('1')).toBe('1');
    expect(formatVariantLabel('0.5')).toBe('0.5');
  });

  test('has no label for an empty id', () => {
    expect(formatVariantLabel('')).toBe('');
    expect(formatVariantLabel('   ')).toBe('');
  });
});
