// One-time copy of the user-authored folders into a custom data directory.
//
// `OPENCHAMBER_DATA_DIR` is documented as "the OpenChamber data directory",
// but for a long time only the flat files (settings, auth, push tokens)
// followed it while `projects/`, `themes/`, and `speech-models/` stayed under
// `~/.config/openchamber`. Now every folder hangs off the data directory, so an
// instance that already ran with a custom directory finds those folders in
// the old place. This copies each one over once: only when the new location
// does not exist yet and the old one does. It copies rather than moves
// because a second instance on the same machine (a custom directory next to
// the default one) must not strip the default instance of its projects.

const USER_DIR_ENTRIES = Object.freeze(['projects', 'themes', 'speech-models']);

const exists = async (fsPromises, target) => fsPromises.access(target).then(() => true, () => false);

/**
 * Copy the user folders from `legacyRoot` into `dataDir`. Returns the entries
 * copied. A no-op when the two roots are the same directory. A folder whose
 * copy fails is reported through `warn` and its partial copy removed; the
 * server keeps starting, reading the (empty) new location.
 */
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
