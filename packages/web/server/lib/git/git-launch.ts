import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import type { SimpleGit } from 'simple-git';

interface SpawnPlugins {
  append(type: 'spawn.args', action: (args: string[]) => string[]): void;
}

const hasPlugins = (git: SimpleGit): git is SimpleGit & { _plugins: SpawnPlugins } => '_plugins' in git;

export const GIT_LAUNCH_DIRECTORY = os.tmpdir();

export const gitArgsIn = (directory: string, args: string[]) => ['-C', path.resolve(directory), ...args];

export const launchesFrom = (git: SimpleGit, directory: string) => {
  if (!hasPlugins(git)) throw new Error('simple-git no longer exposes its spawn plugins');
  git._plugins.append('spawn.args', (args) => gitArgsIn(directory, args));
  return git;
};

export const spawnOutsideProjects = (gitBinary: string, start = spawn) => new Proxy(start, {
  apply: (target, _self, [command, args, options]) => (command === gitBinary && options?.cwd
    ? target(command, gitArgsIn(String(options.cwd), args), { ...options, cwd: GIT_LAUNCH_DIRECTORY })
    : target(command, args, options)),
});
