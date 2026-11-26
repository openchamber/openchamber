import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const fileVersion = (file) => {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
};

const holdsBranch = (head) => {
  try {
    return !fs.readFileSync(head, 'utf8').includes('refs/heads/.invalid');
  } catch {
    return false;
  }
};

const isGitHead = (file) => path.basename(file) === 'HEAD' && path.dirname(file).split(/[\\/]/).includes('.git');

export const createHeadGuard = (input, platform = process.platform) => {
  if (platform !== 'win32' || input.type !== 'file' || !isGitHead(input.target)) return undefined;
  let known = null;
  return () => {
    const current = fileVersion(input.target);
    if (current !== null && current === known) return true;
    known = current !== null && holdsBranch(input.target) ? current : null;
    return false;
  };
};

export const fixWindowsFolderWatches = (platform = process.platform) => {
  if (platform !== 'win32') return;
  globalThis.__openchamberHeadGuard = createHeadGuard;
  const watch = fs.watch;
  fs.watch = function (...args) {
    const watcher = watch.apply(this, args);
    const encoding = typeof args[1] === 'string' ? args[1] : args[1]?.encoding;
    if (encoding && encoding !== 'utf8') return watcher;
    watcher.on('change', (_event, name) => {
      if (name && path.win32.isAbsolute(String(name))) watcher.close();
    });
    return watcher;
  };
  syncBuiltinESMExports();
};
