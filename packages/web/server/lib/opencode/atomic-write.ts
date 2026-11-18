import fs from 'fs';
import path from 'path';

const hasCode = (error: unknown): error is { code?: unknown } => error != null;
const isWindowsReplaceCode = (code: unknown): code is 'EPERM' | 'EACCES' | 'EBUSY' => code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';

const isTransientWindowsReplaceError = <ErrorValue>(error: ErrorValue) =>
  process.platform === 'win32' && isWindowsReplaceCode(hasCode(error) ? error.code : undefined);

function resolveWriteTarget(filePath: string) {
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

export function writeFileAtomic(filePath: string, content: string) {
  const target = resolveWriteTarget(filePath);
  const exists = fs.existsSync(target);
  if (exists) {
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
    if (mode !== null && process.platform !== 'win32') {
      fs.chmodSync(tmp, mode);
    }
    try {
      fs.renameSync(tmp, target);
    } catch (error) {
      if (!isTransientWindowsReplaceError(error)) {
        throw error;
      }
      fs.copyFileSync(tmp, target);
      fs.rmSync(tmp, { force: true });
    }
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
