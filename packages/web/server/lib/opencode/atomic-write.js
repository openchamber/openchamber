import fs from 'fs';
import path from 'path';

const isTransientWindowsReplaceError = (error) =>
  process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);

// The link keeps pointing at the file that gets replaced, including a link
// whose file does not exist yet.
function resolveWriteTarget(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.realpathSync(filePath);
  }
  if (!fs.lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return filePath;
  }
  const target = path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

/**
 * Replace a file's contents without ever exposing a partial file. OpenCode
 * watches its config, agent and command files and reloads on every change, so
 * an in-place write can be read half-finished, and a crash mid-write would
 * leave it truncated. The bytes go to a temp file beside the target (same
 * directory, so the rename stays on one filesystem) and are renamed over it.
 * A symlinked target is resolved first.
 */
export function writeFileAtomic(filePath, content) {
  const target = resolveWriteTarget(filePath);
  const exists = fs.existsSync(target);
  if (exists) {
    // A rename only needs a writable directory; keep refusing a file the user
    // made read-only, as the in-place write did.
    fs.accessSync(target, fs.constants.W_OK);
  }
  const mode = exists ? fs.statSync(target).mode & 0o7777 : null;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // openSync's mode is masked by the umask; an existing file keeps its own.
    if (mode !== null && process.platform !== 'win32') {
      fs.chmodSync(tmp, mode);
    }
    try {
      fs.renameSync(tmp, target);
    } catch (error) {
      if (!isTransientWindowsReplaceError(error)) {
        throw error;
      }
      // Windows rejects the replacement while another process has the target
      // open; fall back to a direct write rather than failing the save.
      fs.copyFileSync(tmp, target);
      fs.rmSync(tmp, { force: true });
    }
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
