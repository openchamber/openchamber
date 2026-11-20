import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function canonicalPluginPath(filePath: string) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function resolveLocalPluginPath(spec: string, sourcePath: string) {
  if (spec.startsWith('file://')) {
    try {
      return canonicalPluginPath(fileURLToPath(spec));
    } catch {
      return undefined;
    }
  }
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return canonicalPluginPath(path.resolve(path.dirname(sourcePath), spec));
  }
  if (path.isAbsolute(spec) || path.win32.isAbsolute(spec)) return canonicalPluginPath(spec);
  return undefined;
}
