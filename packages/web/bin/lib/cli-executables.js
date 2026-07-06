import fs from 'fs';
import path from 'path';

const WINDOWS_EXTENSIONS = process.platform === 'win32'
  ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
  : [''];

function isExecutable(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExplicitBinary(candidate) {
  if (!candidate) {
    return null;
  }
  if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    return isExecutable(resolved) ? resolved : null;
  }
  return null;
}

function searchPathFor(command) {
  const pathValue = process.env.PATH || '';
  const segments = pathValue.split(path.delimiter).filter(Boolean);
  for (const dir of segments) {
    for (const ext of WINDOWS_EXTENSIONS) {
      const fileName = process.platform === 'win32' ? `${command}${ext}` : command;
      const candidate = path.join(dir, fileName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export { resolveExplicitBinary, searchPathFor };
