
export type HighlightResultCacheOptions = {
  maxEntries: number;
  maxBytes: number;
};

type CacheEntry<T> = {
  value: T;
  bytes: number;
};

export const utf16Bytes = (value: string): number => value.length * 2;

const mix32 = (hash: number): number => {
  let h = hash;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
};

export const contentFingerprint = (value: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x27220a95);
  }
  return `${value.length.toString(36)}_${mix32(h1).toString(36)}_${mix32(h2).toString(36)}`;
};

export class HighlightResultCache<T> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly map = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;

  constructor(options: HighlightResultCacheOptions) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxBytes = Math.max(1, options.maxBytes);
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.totalBytes -= existing.bytes;
      this.map.delete(key);
    }

    const entryBytes = Math.max(0, bytes);
    while (
      this.map.size > 0
      && (this.map.size >= this.maxEntries || this.totalBytes + entryBytes > this.maxBytes)
    ) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const oldestEntry = this.map.get(oldest);
      if (oldestEntry !== undefined) this.totalBytes -= oldestEntry.bytes;
      this.map.delete(oldest);
      if (this.map.size === 0) break;
    }

    this.map.set(key, { value, bytes: entryBytes });
    this.totalBytes += entryBytes;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}
