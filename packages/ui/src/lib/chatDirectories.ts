import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const CHAT_DRAFT_PROJECT_ID = 'openchamber:chats';
const MANAGED_CHATS_PATH_SEGMENT = '/.config/openchamber/chats/';
const chatsRootByRuntime = new Map<string, Promise<string>>();
// Sync mirror of the resolved root: the sync helpers below must classify
// relocated chat directories, whose paths lack the well-known segment.
const chatsRootCacheByRuntime = new Map<string, string>();

const joinPath = (base: string, ...parts: string[]): string => {
  const separator = base.includes('\\') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(separator);
};

function cachedChatsRoot(): string | null {
  return chatsRootCacheByRuntime.get(getRuntimeKey()) ?? null;
}

function isWithinRoot(directory: string, root: string): boolean {
  return directory === root || directory.startsWith(`${root}/`);
}

export function isChatDirectoryForHome(directory: string | null | undefined, home: string | null | undefined): boolean {
  const normalized = normalizePath(directory ?? null);
  if (!normalized) return false;
  const cached = cachedChatsRoot();
  if (cached && isWithinRoot(normalized, cached)) return true;
  if (normalized.includes(MANAGED_CHATS_PATH_SEGMENT)) return true;
  const normalizedHome = normalizePath(home ?? null);
  if (!normalizedHome) return false;
  const root = normalizePath(joinPath(normalizedHome, '.config', 'openchamber', 'chats'));
  return Boolean(root && normalized.startsWith(`${root}/`));
}

export function isChatDirectoryPath(directory: string | null | undefined): boolean {
  const normalized = normalizePath(directory ?? null);
  if (!normalized) return false;
  const cached = cachedChatsRoot();
  if (cached && isWithinRoot(normalized, cached)) return true;
  return normalized.includes(MANAGED_CHATS_PATH_SEGMENT);
}

export function getChatsRootFromDirectory(directory: string | null | undefined): string | null {
  const normalized = normalizePath(directory ?? null);
  if (!normalized) return null;
  const cached = cachedChatsRoot();
  if (cached && isWithinRoot(normalized, cached)) return cached;
  const index = normalized.indexOf(MANAGED_CHATS_PATH_SEGMENT);
  return index >= 0
    ? normalized.slice(0, index + MANAGED_CHATS_PATH_SEGMENT.length - 1)
    : null;
}

export function getChatsRootForHome(home: string | null | undefined): string | null {
  const cached = cachedChatsRoot();
  if (cached) return cached;
  const normalizedHome = normalizePath(home ?? null);
  return normalizedHome ? normalizePath(joinPath(normalizedHome, '.config', 'openchamber', 'chats')) : null;
}

async function resolveChatsRoot(): Promise<string> {
  const chatsRoot = await opencodeClient.getFilesystemChatsRoot();
  if (chatsRoot) return chatsRoot;
  const home = await opencodeClient.getFilesystemHome();
  if (!home) throw new Error('Unable to resolve the home directory');
  return joinPath(home, '.config', 'openchamber', 'chats');
}

async function getChatsRootDirectory(): Promise<string> {
  const runtimeKey = getRuntimeKey();
  const existing = chatsRootByRuntime.get(runtimeKey);
  if (existing) return existing;

  const pending = resolveChatsRoot().then((root) => {
    const normalized = normalizePath(root) ?? root;
    chatsRootCacheByRuntime.set(runtimeKey, normalized);
    return root;
  }).catch((error) => {
    chatsRootByRuntime.delete(runtimeKey);
    throw error;
  });
  chatsRootByRuntime.set(runtimeKey, pending);
  return pending;
}

export function warmChatsRootDirectory(): Promise<void> {
  return getChatsRootDirectory().then(() => undefined, () => undefined);
}

export async function createChatDirectory(now = new Date()): Promise<string> {
  const root = await getChatsRootDirectory();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const dateDirectory = joinPath(root, date);
  const id = globalThis.crypto?.randomUUID?.() ?? `${now.getTime()}-${Math.random().toString(36).slice(2)}`;
  const directory = joinPath(dateDirectory, `session-${id}`);
  await opencodeClient.createDirectory(directory);
  return directory;
}

async function isChatDirectory(directory: string | null | undefined): Promise<boolean> {
  const normalized = normalizePath(directory ?? null);
  if (!normalized) return false;
  const root = normalizePath(await getChatsRootDirectory());
  // Legacy chats under the well-known segment stay deletable when the root
  // is relocated; they classify as chats everywhere else already.
  return Boolean(
    (root && (normalized === root || normalized.startsWith(`${root}/`)))
    || normalized.includes(MANAGED_CHATS_PATH_SEGMENT),
  );
}

export async function deleteChatDirectory(directory: string): Promise<void> {
  if (!await isChatDirectory(directory)) return;
  const response = await runtimeFetch('/api/fs/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: directory }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete chat directory (${response.status})`);
  }
}
