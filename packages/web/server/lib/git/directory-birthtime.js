// external: https://nodejs.org/api/fs.html#statsbirthtimems Node can substitute ctime when the filesystem has no creation time.
export async function birthtimeHoldsStill(fsImpl, pathImpl, directory, snapshot) {
  let probe;
  try {
    const before = snapshot ?? await fsImpl.stat(directory);
    if (!Number.isFinite(before.birthtimeMs) || before.birthtimeMs <= 0) return false;
    probe = await fsImpl.mkdtemp(pathImpl.join(directory, '.openchamber-birthtime-'));
    await fsImpl.rmdir(probe);
    probe = undefined;
    const after = await fsImpl.stat(directory);
    return after.dev === before.dev && after.ino === before.ino
      && Number.isFinite(before.ctimeMs) && Number.isFinite(after.ctimeMs)
      && after.ctimeMs !== before.ctimeMs && after.birthtimeMs === before.birthtimeMs;
  } catch {
    return false;
  } finally {
    if (probe) await fsImpl.rmdir(probe).catch(() => {});
  }
}
