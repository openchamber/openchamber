import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const findWindowsExecutable = (name, env) => {
  const result = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean) ?? null;
};

export function resolveBunExecutable(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const findOnPath = options.findOnPath ?? findWindowsExecutable;
  const pathApi = platform === 'win32' ? path.win32 : path;

  const npmExecutable = env.npm_execpath?.trim();
  const npmExecutableName = platform === 'win32' ? 'bun.exe' : 'bun';
  if (
    npmExecutable &&
    pathApi.basename(npmExecutable).toLowerCase() === npmExecutableName &&
    fileExists(npmExecutable)
  ) {
    return npmExecutable;
  }

  if (platform === 'win32') {
    const directExecutable = findOnPath('bun.exe', env);
    if (directExecutable) {
      return directExecutable;
    }

    const shim = findOnPath('bun.cmd', env);
    if (shim) {
      const executable = pathApi.resolve(
        pathApi.dirname(shim),
        'node_modules',
        'bun',
        'bin',
        'bun.exe',
      );
      if (fileExists(executable)) {
        return executable;
      }
    }
  }

  return 'bun';
}
