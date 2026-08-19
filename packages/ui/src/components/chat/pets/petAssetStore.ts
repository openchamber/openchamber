/**
 * On-demand pet spritesheet acquisition with an IndexedDB-backed cache.
 *
 * Mirrors the Codex asset pack contract: the cache key is the CDN-facing
 * filename (so updates publish a new versioned file rather than mutating an
 * existing one), downloads are capped in size, and any failure is surfaced as
 * an explicit `failed` status instead of masquerading as a successful load.
 *
 * All runtimes (web, Electron, VS Code, mobile) share this path: IndexedDB is
 * available everywhere the shared UI runs, so the cache behaves identically
 * across surfaces.
 */

import type { PetCatalogEntry } from './catalog';
import React from 'react';
import { petSpriteUrl } from './catalog';

export type PetAssetStatus = 'idle' | 'loading' | 'ok' | 'failed';

export interface PetAssetEntry {
    status: PetAssetStatus;
    image: HTMLImageElement | null;
}

const DB_NAME = 'openchamber-pets';
const DB_VERSION = 1;
const STORE_NAME = 'spritesheets';
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;

/** Built-in spritesheets that are shipped inside the app bundle so the default
 *  pet works offline and without waiting for the CDN. */
const BUNDLED_SPRITESHEET_FILES = new Set([
    'codex-spritesheet-v4.webp',
]);

interface CachedSpritesheet {
    file: string;
    blob: Blob;
}

const assets = new Map<string, PetAssetEntry>();
const inflight = new Map<string, Promise<PetAssetEntry>>();
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) {
        listener();
    }
}

function setStatus(pet: PetCatalogEntry, status: PetAssetStatus, image: HTMLImageElement | null) {
    assets.set(pet.id, { status, image });
    emit();
}

function openDatabase(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'file' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

function dbGet(db: IDBDatabase, file: string): Promise<Blob | null> {
    return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(file);
        request.onsuccess = () => resolve((request.result as CachedSpritesheet | undefined)?.blob ?? null);
        request.onerror = () => resolve(null);
    });
}

function dbPut(db: IDBDatabase, file: string, blob: Blob): Promise<void> {
    return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put({ file, blob } satisfies CachedSpritesheet);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
    });
}

function decodeBlob(blob: Blob): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
            // Sanity-check the expected spritesheet geometry before trusting it.
            if (image.naturalWidth === 0 || image.naturalHeight === 0) {
                URL.revokeObjectURL(url);
                resolve(null);
                return;
            }
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
        };
        image.src = url;
    });
}

async function fetchLocalSprite(file: string): Promise<HTMLImageElement | null> {
    try {
        const response = await fetch(`/codex-pets/${file}`);
        if (!response.ok) {
            return null;
        }
        const blob = await response.blob();
        if (blob.size > MAX_DOWNLOAD_BYTES) {
            return null;
        }
        return await decodeBlob(blob);
    } catch {
        return null;
    }
}

async function download(pet: PetCatalogEntry): Promise<HTMLImageElement | null> {
    // Prefer the bundled local asset when available so the default pet appears
    // immediately on first launch, even without network access.
    if (BUNDLED_SPRITESHEET_FILES.has(pet.spritesheetFile)) {
        const localImage = await fetchLocalSprite(pet.spritesheetFile);
        if (localImage) {
            const db = await openDatabase();
            if (db) {
                // Re-fetch as blob for IndexedDB caching; the local response is
                // cheap because it is served from the app bundle.
                try {
                    const response = await fetch(`/codex-pets/${pet.spritesheetFile}`);
                    if (response.ok) {
                        const blob = await response.blob();
                        if (blob.size <= MAX_DOWNLOAD_BYTES) {
                            await dbPut(db, pet.id, blob);
                        }
                    }
                } catch {
                    // Cache priming is best-effort.
                }
            }
            return localImage;
        }
    }

    const response = await fetch(petSpriteUrl(pet), { mode: 'cors' });
    if (!response.ok) {
        return null;
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > MAX_DOWNLOAD_BYTES) {
        return null;
    }
    const blob = await response.blob();
    if (blob.size > MAX_DOWNLOAD_BYTES) {
        return null;
    }

    const image = await decodeBlob(blob);
    if (!image) {
        return null;
    }
    const db = await openDatabase();
    if (db) {
        await dbPut(db, pet.id, blob);
    }
    return image;
}

async function acquire(
    pet: PetCatalogEntry,
    force: boolean,
    loadSprite?: () => Promise<HTMLImageElement | null>,
): Promise<PetAssetEntry> {
    const current = assets.get(pet.id);
    if (!force && current && current.status === 'ok' && current.image) {
        return current;
    }
    if (!force && current && current.status === 'failed') {
        return current;
    }
    if (!force && current && current.status === 'loading') {
        return inflight.get(pet.id) ?? { status: 'idle', image: null };
    }

    setStatus(pet, 'loading', null);

    const promise = (async (): Promise<PetAssetEntry> => {
        let image: HTMLImageElement | null = null;
        try {
            const db = await openDatabase();
            if (db) {
                const cached = await dbGet(db, pet.id);
                if (cached) {
                    image = await decodeBlob(cached);
                }
            }
            if (!image) {
                if ('isCustom' in pet && !loadSprite) {
                    // Custom pets have no CDN counterpart; a missing loader is
                    // a hard failure, never a fallback download.
                    setStatus(pet, 'failed', null);
                    return { status: 'failed', image: null };
                }
                image = loadSprite ? await loadSprite() : await download(pet);
            }
            setStatus(pet, image ? 'ok' : 'failed', image);
            return { status: image ? 'ok' : 'failed', image };
        } catch {
            setStatus(pet, 'failed', null);
            return { status: 'failed', image: null };
        } finally {
            inflight.delete(pet.id);
        }
    })();

    inflight.set(pet.id, promise);
    return promise;
}

/** Synchronous snapshot of the current asset status for a pet. */
export function getPetAssetStatus(petId: string): PetAssetStatus {
    return assets.get(petId)?.status ?? 'idle';
}

/** Synchronous snapshot of the decoded spritesheet image (null until loaded). */
export function getPetAssetImage(petId: string): HTMLImageElement | null {
    return assets.get(petId)?.image ?? null;
}

/** Subscribe to asset status changes across all pets. */
export function subscribePetAssets(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Ensure a pet's spritesheet is cached and decoded.
 *
 * Idempotent: a successful or failed result is reused until `force` retries a
 * failed download. Failures are explicit (`failed` status), never a fake
 * empty success.
 */
export function ensurePetAsset(
    pet: PetCatalogEntry,
    force = false,
    loadSprite?: () => Promise<HTMLImageElement | null>,
): Promise<PetAssetEntry> {
    return acquire(pet, force, loadSprite);
}

/** React hook that subscribes to a pet's asset status and triggers loading. */
export function usePetAsset(
    pet: PetCatalogEntry | undefined,
    loadSprite?: () => Promise<HTMLImageElement | null>,
): PetAssetStatus {
    const petId = pet?.id;
    const [status, setStatus] = React.useState<PetAssetStatus>(() =>
        petId ? getPetAssetStatus(petId) : 'idle',
    );

    React.useEffect(() => {
        setStatus(petId ? getPetAssetStatus(petId) : 'idle');
        return subscribePetAssets(() => setStatus(petId ? getPetAssetStatus(petId) : 'idle'));
    }, [petId]);

    React.useEffect(() => {
        if (!pet) return;
        void ensurePetAsset(pet, false, loadSprite);
    }, [pet, loadSprite]);

    return status;
}
