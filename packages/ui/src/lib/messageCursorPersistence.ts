const DB_NAME = 'openchamber-message-cursors';
const STORE_NAME = 'cursors';
const DB_VERSION = 1;
const FALLBACK_KEY = 'openchamber.messageCursors';

type CursorRecord = {
  messageId: string;
  completedAt: number;
};

const isBrowser = () => typeof window !== 'undefined';

const hasIndexedDbSupport = () => {
  return isBrowser() && typeof indexedDB !== 'undefined';
};

const openDatabase = (): Promise<IDBDatabase> => {
  if (!hasIndexedDbSupport()) {
    return Promise.reject(new Error('IndexedDB not supported'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open IndexedDB'));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });
};

let dbPromise: Promise<IDBDatabase> | null = null;

const getDatabase = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = openDatabase()
      .then((db) => {
        db.onclose = () => {
          dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
        };
        return db;
      })
      .catch((error: unknown) => {
        dbPromise = null;
        throw error;
      });
  }
  return dbPromise;
};

const readFallback = (): Record<string, CursorRecord> => {
  if (!isBrowser()) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(FALLBACK_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, CursorRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeFallback = (map: Record<string, CursorRecord>) => {
  if (!isBrowser()) {
    return;
  }

  try {
    window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(map));
  } catch { /* ignored */ }
};

export const saveSessionCursor = async (
  sessionId: string,
  messageId: string,
  completedAt: number
) => {
  if (!sessionId || !messageId) {
    return;
  }

  if (hasIndexedDbSupport()) {
    try {
      const db = await getDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ messageId, completedAt }, sessionId);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Cursor write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Cursor write aborted'));
      });
      return;
    } catch { /* ignored */ }
  }

  const fallback = readFallback();
  fallback[sessionId] = { messageId, completedAt };
  writeFallback(fallback);
};

export const readSessionCursor = async (
  sessionId: string
): Promise<CursorRecord | null> => {
  if (!sessionId) {
    return null;
  }

  if (hasIndexedDbSupport()) {
    try {
      const db = await getDatabase();
      const record = await new Promise<CursorRecord | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(sessionId);

        request.onsuccess = () => {
          resolve((request.result as CursorRecord) ?? null);
        };

        request.onerror = () => reject(request.error ?? new Error('Cursor read failed'));
        tx.onerror = () => reject(tx.error ?? new Error('Cursor read failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Cursor read aborted'));
      });
      return record;
    } catch { /* ignored */ }
  }

  const fallback = readFallback();
  return fallback[sessionId] ?? null;
};

export const clearSessionCursor = async (sessionId: string) => {
  if (!sessionId) {
    return;
  }

  if (hasIndexedDbSupport()) {
    try {
      const db = await getDatabase();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(sessionId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Cursor delete failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Cursor delete aborted'));
      });
    } catch { /* ignored */ }
  }

  const fallback = readFallback();
  if (sessionId in fallback) {
    delete fallback[sessionId];
    writeFallback(fallback);
  }
};
