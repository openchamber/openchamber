import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { asNonEmptyString } from '../shared/guards.js';

export const CHATS_SCOPE_PUBLIC_ID = 'openchamber:chats';

interface ChatsDefaultsSettings { chatsDefaultAgent?: unknown; chatsDefaultModel?: unknown; chatsDefaultVariant?: unknown }

export const readChatsDefaults = (settings: ChatsDefaultsSettings | null | undefined) => ({
  defaultAgent: asNonEmptyString(settings?.chatsDefaultAgent),
  defaultModel: asNonEmptyString(settings?.chatsDefaultModel),
  defaultVariant: asNonEmptyString(settings?.chatsDefaultVariant),
});

const resolveThroughExistingAncestor = async (directory: string): Promise<string> => {
  const missing: string[] = [];
  let candidate = directory;
  for (;;) {
    try {
      return path.join(await fs.realpath(candidate), ...missing);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return directory;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
};

export const createChatsScope = (chatsRoot: string) => {
  const root = path.resolve(chatsRoot);
  let realRoot = root;
  const id = createProjectIdFromPath(root);

  const isUnder = (base: string, directory: string) => {
    const relative = path.relative(base, path.resolve(directory));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  const contains = (directory: string) => isUnder(root, directory) || (realRoot !== root && isUnder(realRoot, directory));

  const refreshRealRoot = async () => {
    realRoot = await resolveThroughExistingAncestor(root);
    return realRoot;
  };
  void refreshRealRoot();

  const createChatDirectory = async (now = new Date()) => {
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    const directory = path.join(root, date, `session-${crypto.randomUUID()}`);
    await fs.mkdir(directory, { recursive: true });
    return directory;
  };

  const discardChatDirectory = (directory: string) => fs.rmdir(directory).catch(() => undefined);

  return {
    id,
    root,
    toStorageID: (projectID: string) => (projectID === CHATS_SCOPE_PUBLIC_ID ? id : projectID),
    toPublicID: (projectID: string) => (projectID === id ? CHATS_SCOPE_PUBLIC_ID : projectID),
    contains,
    refreshRealRoot,
    createChatDirectory,
    discardChatDirectory,
  };
};
