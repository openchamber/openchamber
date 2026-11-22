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

export const createChatsScope = (chatsRoot: string) => {
  const root = path.resolve(chatsRoot);
  const id = createProjectIdFromPath(root);

  const contains = (directory: string) => {
    const relative = path.relative(root, path.resolve(directory));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

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
    createChatDirectory,
    discardChatDirectory,
  };
};
