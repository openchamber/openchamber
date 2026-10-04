import { describe, expect, test } from 'bun:test';
import {
  decodeDeviceStorageNamespace,
  deviceStorageNamespaceKey,
  deviceStorageTotalBytes,
  prepareDeviceStorageWrite,
  removeDeviceStorageNamespace,
} from './device-storage-records';

const key = 'guest\0storage-id';
const record = (pairs: [string, unknown][]) => {
  const json = JSON.stringify(pairs);
  return { key, json, bytes: new TextEncoder().encode(json).length };
};

describe('device storage records', () => {
  test('partitions identical server identities by host runtime key', () => {
    expect(deviceStorageNamespaceKey('https://one.example', 'guest', '00000000-0000-4000-8000-000000000000'))
      .not.toBe(deviceStorageNamespaceKey('https://two.example', 'guest', '00000000-0000-4000-8000-000000000000'));
  });

  test('preserves prototype-looking keys and distinguishes null from absent', () => {
    const current = decodeDeviceStorageNamespace(record([['__proto__', null], ['constructor', 1]]), key);
    expect(current?.values.get('__proto__')).toBeNull();
    expect(current?.values.get('constructor')).toBe(1);
    expect(current?.values.get('missing')).toBeUndefined();
  });

  test('rejects corrupt records without mutating the supplied record', () => {
    const corrupt = { key, json: '[[' + JSON.stringify('a') + ',1],[' + JSON.stringify('a') + ',2]]', bytes: 17 };
    const before = { ...corrupt };
    expect(() => decodeDeviceStorageNamespace(corrupt, key)).toThrow();
    expect(corrupt).toEqual(before);
    expect(() => decodeDeviceStorageNamespace({ ...record([['a', 1]]), bytes: -1 }, key)).toThrow();
    expect(() => decodeDeviceStorageNamespace({ ...record([['a', 1]]), bytes: 1 }, key)).toThrow();
  });

  test('enforces UTF-8 value, namespace, key count, and global limits without changing prior records', () => {
    expect(() => prepareDeviceStorageWrite(null, { op: 'set', key: 'value', value: 'x'.repeat(65_535) }, 0)).toThrow();
    expect(prepareDeviceStorageWrite(null, { op: 'set', key: 'value', value: 'x'.repeat(65_534) }, 0).record).not.toBeNull();
    const oversizedJson = JSON.stringify([['large', 'x'.repeat(2_097_151)]]);
    expect(() => decodeDeviceStorageNamespace({ key, json: oversizedJson, bytes: oversizedJson.length }, key)).toThrow();
    const full = decodeDeviceStorageNamespace(record(Array.from({ length: 2_000 }, (_, index) => [`key-${index}`, index])), key);
    expect(() => prepareDeviceStorageWrite(full, { op: 'set', key: 'one-more', value: 1 }, full?.record.bytes ?? 0)).toThrow();
    const prior = decodeDeviceStorageNamespace(record([['keep', '界']]), key);
    expect(prior?.record.bytes).toBe(16);
    const total = 16_777_216;
    expect(() => prepareDeviceStorageWrite(prior, { op: 'set', key: 'next', value: 1 }, total)).toThrow();
    expect(prior?.values.get('keep')).toBe('界');
  });

  test('keeps unrelated global bytes when deleting a missing or existing namespace', () => {
    expect(() => prepareDeviceStorageWrite(null, { op: 'keys' }, 80)).toThrow('Expected a device storage write');
    expect(prepareDeviceStorageWrite(null, { op: 'delete', key: 'missing' }, 80).totalBytes).toBe(80);
    const current = decodeDeviceStorageNamespace(record([['saved', 1]]), key);
    const total = (current?.record.bytes ?? 0) + 80;
    expect(removeDeviceStorageNamespace(current, total).totalBytes).toBe(80);
    expect(deviceStorageTotalBytes({ key: 'total', bytes: 80 })).toBe(80);
  });
});
