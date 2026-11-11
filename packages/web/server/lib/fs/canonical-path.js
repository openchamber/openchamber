// A chats root may not exist until the first draft. Resolve its existing
// ancestor so both that first mkdir and later OpenCode sessions use disk casing.
export const canonicalDirectoryPath = async (directory, fsPromises, path) => {
  let ancestor = path.resolve(directory);
  const missing = [];
  for (;;) {
    try {
      return path.join(await fsPromises.realpath(ancestor), ...missing);
    } catch (error) {
      const parent = path.dirname(ancestor);
      if (error.code !== 'ENOENT' || parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
};
