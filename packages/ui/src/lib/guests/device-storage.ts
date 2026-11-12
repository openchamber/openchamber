import { z } from 'zod';
import {
  type GuestStorageRequest,
  type GuestStorageResult,
} from '@openchamber/sdk';
import { guestStorageRequestSchema } from '@openchamber/sdk/schemas';
import {
  decodeDeviceStorageNamespace,
  deviceStorageNamespaceKey,
  deviceStorageMetaSchema,
  deviceStorageNamespaceSchema,
  deviceStorageTotalBytes,
  prepareDeviceStorageWrite,
  removeDeviceStorageNamespace,
} from './device-storage-records';

type DeviceGuestStorageIdentity = { runtimeKey: string; guestId: string; storageId: string };

const DATABASE = 'openchamber-guest-device-storage';
const VERSION = 1;
const NAMESPACES = 'namespaces';
const META = 'meta';
const TOTAL = 'total';
const identitySchema = z.object({ runtimeKey: z.string().min(1).max(4096), guestId: z.string().regex(/^[a-z][a-z0-9-]*$/), storageId: z.string().uuid() }).strict();

const requestValue = <T>(request: IDBRequest, schema: z.ZodType<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => {
    try {
      resolve(schema.parse(request.result));
    } catch (error) {
      reject(error);
    }
  };
  request.onerror = () => reject(request.error ?? new Error('Device storage request failed.'));
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('Device storage transaction aborted.'));
  transaction.onerror = () => reject(transaction.error ?? new Error('Device storage transaction failed.'));
});

const abortAndWait = async (transaction: IDBTransaction, completion: Promise<void>) => {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have completed after a request error.
  }
  await completion.catch(() => undefined);
};

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const factory = globalThis.indexedDB;
  if (!factory) {
    reject(new Error('Device storage is unavailable.'));
    return;
  }
  const request = factory.open(DATABASE, VERSION);
  let blocked = false;
  request.onblocked = () => { blocked = true; reject(new Error('Device storage database is busy.')); };
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore(NAMESPACES, { keyPath: 'key' });
    database.createObjectStore(META, { keyPath: 'key' });
  };
  request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  request.onerror = () => reject(request.error ?? new Error('Device storage is unavailable.'));
});

export const runDeviceGuestStorage = async (
  identity: DeviceGuestStorageIdentity,
  request: GuestStorageRequest,
  authorize: () => boolean,
): Promise<GuestStorageResult> => {
  const parsedIdentity = identitySchema.parse(identity);
  const parsedRequest = guestStorageRequestSchema.parse(request);
  const database = await openDatabase();
  const key = deviceStorageNamespaceKey(parsedIdentity.runtimeKey, parsedIdentity.guestId, parsedIdentity.storageId);
  try {
    const write = parsedRequest.op === 'set' || parsedRequest.op === 'delete';
    const transaction = database.transaction(write ? [NAMESPACES, META] : NAMESPACES, write ? 'readwrite' : 'readonly');
    const completion = transactionDone(transaction);
    try {
      const namespaces = transaction.objectStore(NAMESPACES);
      const current = decodeDeviceStorageNamespace(await requestValue(namespaces.get(key), deviceStorageNamespaceSchema.optional()), key);
      const values = current?.values ?? new Map();
      if (parsedRequest.op === 'get') {
        await completion;
        if (!authorize()) throw new Error('Device storage authorization changed.');
        const value = values.get(parsedRequest.key);
        return value === undefined
          ? { storage: true, op: 'get', found: false }
          : { storage: true, op: 'get', found: true, value };
      }
      if (parsedRequest.op === 'keys') {
        await completion;
        if (!authorize()) throw new Error('Device storage authorization changed.');
        return { storage: true, op: 'keys', keys: [...values.keys()].sort() };
      }

      const meta = transaction.objectStore(META);
      const total = deviceStorageTotalBytes(await requestValue(meta.get(TOTAL), deviceStorageMetaSchema.optional()));
      const prepared = prepareDeviceStorageWrite(current, parsedRequest, total);
      if (!authorize()) throw new Error('Device storage authorization changed.');
      if (prepared.record === null) namespaces.delete(key);
      else namespaces.put({ ...prepared.record, key });
      meta.put({ key: TOTAL, bytes: prepared.totalBytes });
      await completion;
      return prepared.result;
    } catch (error) {
      await abortAndWait(transaction, completion);
      throw error;
    }
  } finally {
    database.close();
  }
};

/** Called only after a confirmed successful uninstall, never catalog omission. */
export const removeDeviceGuestStorage = async (identity: DeviceGuestStorageIdentity): Promise<void> => {
  const parsedIdentity = identitySchema.parse(identity);
  const database = await openDatabase();
  try {
    const transaction = database.transaction([NAMESPACES, META], 'readwrite');
    const completion = transactionDone(transaction);
    try {
      const key = deviceStorageNamespaceKey(parsedIdentity.runtimeKey, parsedIdentity.guestId, parsedIdentity.storageId);
      const namespaces = transaction.objectStore(NAMESPACES);
      const current = decodeDeviceStorageNamespace(await requestValue(namespaces.get(key), deviceStorageNamespaceSchema.optional()), key);
      const meta = transaction.objectStore(META);
      const total = deviceStorageTotalBytes(await requestValue(meta.get(TOTAL), deviceStorageMetaSchema.optional()));
      const removed = removeDeviceStorageNamespace(current, total);
      namespaces.delete(key);
      meta.put({ key: TOTAL, bytes: removed.totalBytes });
      await completion;
    } catch (error) {
      await abortAndWait(transaction, completion);
      throw error;
    }
  } finally {
    database.close();
  }
};
