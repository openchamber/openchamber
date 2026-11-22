import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isExistingPluginFileName(name: unknown): name is string {
  return typeof name === 'string'
    && !name.startsWith('.')
    && !name.includes('..')
    && /^[^/\\\0]+\.(js|ts|mjs|cjs)$/.test(name);
}

export function pluginDirEntryKind(entry: fs.Dirent, absolutePath: string): 'file' | 'directory' | null {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (!entry.isSymbolicLink()) return null;
  try {
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) return 'file';
    return stat.isDirectory() ? 'directory' : null;
  } catch {
    return null;
  }
}

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
