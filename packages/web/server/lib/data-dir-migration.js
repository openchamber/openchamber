
const USER_DIR_ENTRIES = Object.freeze(['projects', 'themes', 'speech-models']);

const exists = async (fsPromises, target) => fsPromises.access(target).then(() => true, () => false);

export const migrateLegacyUserDirs = async ({ fsPromises, path, dataDir, legacyRoot, warn = () => {}, entries = USER_DIR_ENTRIES }) => {
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

export const ensureChatsDir = async ({ fsPromises, chatsDir, warn = () => {} }) => {
  try {
    await fsPromises.mkdir(chatsDir, { recursive: true });
    return true;
  } catch (error) {
    warn(`Could not create the chats folder ${chatsDir}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};
