import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProjectIdFromPath } from '../projects/project-id.js';

// The id the UI already uses for the chats list (CHAT_DRAFT_PROJECT_ID). It is
// not a valid file name on Windows, so tasks are stored under the chats root's
// path id instead and this id only exists at the API edge.
export const CHATS_SCOPE_PUBLIC_ID = 'openchamber:chats';

/**
 * Chats have no project checkout: every chat owns a fresh directory under the
 * managed chats root. A scheduled task in the chats scope therefore stores its
 * definition under the root and opens a new chat directory for each run.
 */
export const createChatsScope = (chatsRoot) => {
  const root = path.resolve(chatsRoot);
  const id = createProjectIdFromPath(root);

  const contains = (directory) => {
    const relative = path.relative(root, path.resolve(directory));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  // Same layout the UI uses for a new chat: <root>/<yyyy-mm-dd>/session-<uuid>.
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

  // Only for a run that never got a session: the directory is still empty,
  // and a non-recursive removal refuses to touch anything that is not.
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
