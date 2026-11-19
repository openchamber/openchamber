import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectIdFromPath } from '../projects/project-id.js';

export const CHATS_SCOPE_PUBLIC_ID = 'openchamber:chats';

export const createChatsScope = (chatsRoot: string) => {
  const root = path.resolve(chatsRoot);
  // A directory reached through a symlinked home arrives both ways: the proxy
  // keeps the spelling a client used, while the server's own create resolves it.
  const realRoot = (() => {
    try {
      return fsSync.realpathSync(root);
    } catch {
      return root;
    }
  })();
  const id = createProjectIdFromPath(root);

  const isUnder = (base: string, directory: string) => {
    const relative = path.relative(base, path.resolve(directory));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  const contains = (directory: string) =>
    isUnder(root, directory) || (realRoot !== root && isUnder(realRoot, directory));

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
