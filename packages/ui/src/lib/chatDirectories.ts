import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const CHAT_DRAFT_PROJECT_ID = 'openchamber:chats';
type ChatRoots = { configured: string; legacy: string };
const chatsRootByRuntime = new Map<string, Promise<ChatRoots>>();
const chatsRootCacheByRuntime = new Map<string, ChatRoots>();

const joinPath = (base: string, ...parts: string[]): string =>
  [base.replace(/[\\/]+$/, ''), ...parts].join('/');

function legacyRootForHome(home: string | null | undefined): string | null {
  const normalized = normalizePath(home);
  return normalized ? joinPath(normalized, '.config', 'openchamber', 'chats') : null;
}

function isWithinRoot(directory: string, root: string): boolean {
  return !directory.split('/').some((part) => part === '..' || part === '.')
    && (directory === root || directory.startsWith(`${root}/`));
}

function cachedRoots(): ChatRoots | undefined {
  return chatsRootCacheByRuntime.get(getRuntimeKey());
}

export function getChatsRootFromDirectory(directory: string | null | undefined): string | null {
  const normalized = normalizePath(directory);
  const roots = cachedRoots();
  if (!normalized || !roots) return null;
  if (isWithinRoot(normalized, roots.configured)) return roots.configured;
  return isWithinRoot(normalized, roots.legacy) ? roots.legacy : null;
}

export function isChatDirectoryPath(directory: string | null | undefined): boolean {
  return getChatsRootFromDirectory(directory) !== null;
}

export function isChatDirectoryForHome(directory: string | null | undefined, home: string | null | undefined): boolean {
  if (isChatDirectoryPath(directory)) return true;
  const normalized = normalizePath(directory);
  const legacy = legacyRootForHome(home);
  return Boolean(normalized && legacy && isWithinRoot(normalized, legacy));
}

export function getChatsRootForHome(home: string | null | undefined): string | null {
  return cachedRoots()?.configured ?? legacyRootForHome(home);
}

async function getChatRoots(): Promise<ChatRoots> {
  const runtimeKey = getRuntimeKey();
  const existing = chatsRootByRuntime.get(runtimeKey);
  if (existing) return existing;
  const pending = opencodeClient.getFilesystemHomeInfo().then(({ home, chatsRoot }) => {
    const legacy = legacyRootForHome(home);
    const configured = normalizePath(chatsRoot) ?? legacy;
    if (!legacy || !configured) throw new Error('Unable to resolve chat directories');
    const roots = { configured, legacy };
    chatsRootCacheByRuntime.set(runtimeKey, roots);
    return roots;
  }).catch((error) => {
    chatsRootByRuntime.delete(runtimeKey);
    throw error;
  });
  chatsRootByRuntime.set(runtimeKey, pending);
  return pending;
}

/** Required before a global snapshot can classify or persist managed chats. */
export async function ensureChatsRootDirectory(): Promise<void> {
  await getChatRoots();
}

export function warmChatsRootDirectory(): Promise<void> {
  return ensureChatsRootDirectory().catch(() => undefined);
}

export async function createChatDirectory(now = new Date()): Promise<string> {
  const runtimeKey = getRuntimeKey();
  const roots = await getChatRoots();
  if (getRuntimeKey() !== runtimeKey) throw new Error('Runtime changed while preparing chat directory');
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const id = globalThis.crypto?.randomUUID?.() ?? `${now.getTime()}-${Math.random().toString(36).slice(2)}`;
  const directory = joinPath(roots.configured, date, `session-${id}`);
  await opencodeClient.createDirectory(directory);
  return directory;
}

export async function deleteChatDirectory(directory: string): Promise<void> {
  const normalized = normalizePath(directory);
  if (!normalized) return;
  const runtimeKey = getRuntimeKey();
  const roots = await getChatRoots();
  if (getRuntimeKey() !== runtimeKey) throw new Error('Runtime changed while deleting chat directory');
  // A session may own a descendant, never either shared chats root itself.
  if (normalized === roots.configured || normalized === roots.legacy) return;
  if (!isWithinRoot(normalized, roots.configured) && !isWithinRoot(normalized, roots.legacy)) return;
  const response = await runtimeFetch('/api/fs/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: directory }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete chat directory (${response.status})`);
  }
}
