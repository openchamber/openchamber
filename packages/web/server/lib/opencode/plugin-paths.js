import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Physical identity when available; missing declarations still keep their path. */
export function canonicalPluginPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/** OpenCode resolves local declarations relative to the declaring config file. */
export function resolveLocalPluginPath(spec, sourcePath) {
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
