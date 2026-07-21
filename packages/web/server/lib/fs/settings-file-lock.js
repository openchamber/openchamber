// Serializes writes to a given file path across every caller in this
// process. Electron's main process and the in-process OpenChamber web
// server each persist settings.json through their own module and neither
// knows about the other's writer — without this, their read-modify-write
// cycles interleave and can silently drop each other's changes. Keyed by
// path (not hardcoded to settings.json) so any other shared file can use it.
const writeLocksByPath = new Map();

export const withFileWriteLock = (filePath, task) => {
  const previous = writeLocksByPath.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
  writeLocksByPath.set(filePath, next.then(() => {}, () => {}));
  return next;
};
