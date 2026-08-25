import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const CHAT_DRAFT_PROJECT_ID = 'openchamber:chats';
const MANAGED_CHATS_PATH_SEGMENT = '/.config/openchamber/chats/';
const chatsRootByRuntime = new Map<string, Promise<string>>();

const joinPath = (base: string, ...parts: string[]): string => {
  const separator = base.includes('\\') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(separator);
};

export function isChatDirectoryForHome(directory: string | null | undefined, home: string | null | undefined): boolean {
  const normalized = normalizePath(directory ?? null);
  if (normalized?.includes(MANAGED_CHATS_PATH_SEGMENT)) return true;
  const normalizedHome = normalizePath(home ?? null);
  if (!normalized || !normalizedHome) return false;
  const root = normalizePath(joinPath(normalizedHome, '.config', 'openchamber', 'chats'));
  return Boolean(root && normalized.startsWith(`${root}/`));
}

export function isChatDirectoryPath(directory: string | null | undefined): boolean {
  return normalizePath(directory ?? null)?.includes(MANAGED_CHATS_PATH_SEGMENT) === true;
}

export function getChatsRootFromDirectory(directory: string | null | undefined): string | null {
  const normalized = normalizePath(directory ?? null);
  const index = normalized?.indexOf(MANAGED_CHATS_PATH_SEGMENT) ?? -1;
  return normalized && index >= 0
    ? normalized.slice(0, index + MANAGED_CHATS_PATH_SEGMENT.length - 1)
    : null;
}

export function getChatsRootForHome(home: string | null | undefined): string | null {
  const normalizedHome = normalizePath(home ?? null);
  return normalizedHome ? normalizePath(joinPath(normalizedHome, '.config', 'openchamber', 'chats')) : null;
}

async function getChatsRootDirectory(): Promise<string> {
  const runtimeKey = getRuntimeKey();
  const existing = chatsRootByRuntime.get(runtimeKey);
  if (existing) return existing;

  const pending = opencodeClient.getFilesystemHome().then((home) => {
    if (!home) throw new Error('Unable to resolve the home directory');
    return joinPath(home, '.config', 'openchamber', 'chats');
  }).catch((error) => {
    chatsRootByRuntime.delete(runtimeKey);
    throw error;
  });
  chatsRootByRuntime.set(runtimeKey, pending);
  return pending;
}

export function warmChatsRootDirectory(): void {
  void getChatsRootDirectory().catch(() => undefined);
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
  return Boolean(root && (normalized === root || normalized.startsWith(`${root}/`)));
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
