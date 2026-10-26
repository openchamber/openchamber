import { z } from 'zod';
import {
  GUEST_DEVICE_STORAGE_TOTAL_BYTES,
  GUEST_STORAGE_KEY_MAX,
  GUEST_STORAGE_KEYS_MAX,
  GUEST_STORAGE_TOTAL_BYTES,
  GUEST_STORAGE_VALUE_BYTES,
  type GuestStorageRequest,
  type JsonValue,
} from '@openchamber/sdk';

export const deviceStorageNamespaceSchema = z.object({
  key: z.string().min(1),
  json: z.string().max(GUEST_STORAGE_TOTAL_BYTES),
  bytes: z.number().int().min(1).max(GUEST_STORAGE_TOTAL_BYTES),
}).strict();
export const deviceStorageMetaSchema = z.object({
  key: z.literal('total'),
  bytes: z.number().int().nonnegative().max(GUEST_DEVICE_STORAGE_TOTAL_BYTES),
}).strict();

type DeviceStorageNamespaceInput = { key: string; json: string; bytes: number };
type DeviceStorageMetaInput = { key: 'total'; bytes: number };

const storageKeySchema = z.string().min(1).max(GUEST_STORAGE_KEY_MAX);
const pairsSchema = z.array(z.tuple([storageKeySchema, z.json()])).max(GUEST_STORAGE_KEYS_MAX);
const byteLength = (value: string) => new TextEncoder().encode(value).length;

/** Encodes all host-owned identity parts without delimiter ambiguity. */
export const deviceStorageNamespaceKey = (runtimeKey: string, guestId: string, storageId: string) => (
  JSON.stringify([runtimeKey, guestId, storageId])
);

export const decodeDeviceStorageNamespace = (existing: DeviceStorageNamespaceInput | undefined, expectedKey: string) => {
  if (existing === undefined) return null;
  const record = deviceStorageNamespaceSchema.parse(existing);
  if (record.key !== expectedKey) throw new Error('Device storage identity is corrupt.');
  const pairs = pairsSchema.parse(JSON.parse(record.json));
  if (byteLength(record.json) !== record.bytes) throw new Error('Device storage byte count is corrupt.');
  const values = new Map<string, JsonValue>();
  for (const [key, value] of pairs) {
    if (values.has(key)) throw new Error('Device storage contains duplicate keys.');
    values.set(key, value);
  }
  return { record, values };
};

export const deviceStorageTotalBytes = (existing: DeviceStorageMetaInput | undefined) => (
  existing === undefined ? 0 : deviceStorageMetaSchema.parse(existing).bytes
);

export const prepareDeviceStorageWrite = (
  current: ReturnType<typeof decodeDeviceStorageNamespace>,
  request: GuestStorageRequest,
  totalBytes: number,
) => {
  if (request.op !== 'set' && request.op !== 'delete') throw new Error('Expected a device storage write.');
  const values = new Map(current?.values);
  if (request.op === 'set') {
    const value = JSON.stringify(request.value);
    if (byteLength(value) > GUEST_STORAGE_VALUE_BYTES) throw new Error('Device storage value exceeds 64 KiB.');
    values.set(request.key, request.value);
  } else {
    values.delete(request.key);
  }
  const json = values.size === 0 ? null : JSON.stringify([...values]);
  const bytes = json === null ? 0 : byteLength(json);
  if (values.size > GUEST_STORAGE_KEYS_MAX || bytes > GUEST_STORAGE_TOTAL_BYTES) throw new Error('Device storage namespace is full.');
  const previousBytes = current?.record.bytes ?? 0;
  if (!Number.isInteger(totalBytes) || totalBytes < previousBytes || totalBytes > GUEST_DEVICE_STORAGE_TOTAL_BYTES) throw new Error('Device storage byte count is corrupt.');
  const nextTotalBytes = totalBytes - previousBytes + bytes;
  if (nextTotalBytes > GUEST_DEVICE_STORAGE_TOTAL_BYTES) throw new Error('Device storage is full.');
  return {
    record: json === null ? null : { json, bytes },
    totalBytes: nextTotalBytes,
    result: { storage: true, op: request.op } as const,
  };
};

export const removeDeviceStorageNamespace = (
  current: ReturnType<typeof decodeDeviceStorageNamespace>,
  totalBytes: number,
) => {
  const previousBytes = current?.record.bytes ?? 0;
  if (!Number.isInteger(totalBytes) || totalBytes < previousBytes || totalBytes > GUEST_DEVICE_STORAGE_TOTAL_BYTES) throw new Error('Device storage byte count is corrupt.');
  return { record: null, totalBytes: totalBytes - previousBytes };
};
