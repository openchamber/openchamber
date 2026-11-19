import type * as fs from 'node:fs/promises';
import type pathModule from 'node:path';

interface MigrationOptions {
  fsPromises: Pick<typeof fs, 'access' | 'mkdir' | 'cp' | 'rm'>;
  path: Pick<typeof pathModule, 'resolve' | 'join'>;
  dataDir: string;
  legacyRoot: string;
  warn?: (message: string) => void;
  entries?: readonly string[];
}

const USER_DIR_ENTRIES = Object.freeze(['projects', 'themes', 'speech-models']);

const exists = async (fsPromises: Pick<typeof fs, 'access'>, target: string) => fsPromises.access(target).then(() => true, () => false);

export const migrateLegacyUserDirs = async ({ fsPromises, path, dataDir, legacyRoot, warn = () => {}, entries = USER_DIR_ENTRIES }: MigrationOptions) => {
  if (path.resolve(dataDir) === path.resolve(legacyRoot)) return [];
  const moved = [];
  for (const entry of entries) {
    const from = path.join(legacyRoot, entry);
    const to = path.join(dataDir, entry);
    if (await exists(fsPromises, to) || !(await exists(fsPromises, from))) continue;
    try {
      await fsPromises.mkdir(dataDir, { recursive: true });
      await fsPromises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
      moved.push(entry);
    } catch (error) {
      await fsPromises.rm(to, { recursive: true, force: true }).catch(() => {});
      warn(`Failed to copy ${from} to ${to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return moved;
};

export const ensureChatsDir = async ({ fsPromises, chatsDir, warn = () => {} }: {
  fsPromises: Pick<typeof fs, 'mkdir'>;
  chatsDir: string;
  warn?: (message: string) => void;
}) => {
  try {
    await fsPromises.mkdir(chatsDir, { recursive: true });
    return true;
  } catch (error) {
    warn(`Could not create the chats folder ${chatsDir}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};
