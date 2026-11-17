import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectIdFromPath } from '../projects/project-id.js';

export const CHATS_SCOPE_PUBLIC_ID = 'openchamber:chats';

export const createChatsScope = (chatsRoot) => {
  const root = path.resolve(chatsRoot);
  const id = createProjectIdFromPath(root);

  const contains = (directory) => {
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

  const discardChatDirectory = (directory) => fs.rmdir(directory).catch(() => undefined);

  return {
    id,
    root,
    toStorageID: (projectID) => (projectID === CHATS_SCOPE_PUBLIC_ID ? id : projectID),
    toPublicID: (projectID) => (projectID === id ? CHATS_SCOPE_PUBLIC_ID : projectID),
    contains,
    createChatDirectory,
    discardChatDirectory,
  };
};
