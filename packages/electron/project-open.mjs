import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_OPEN_ARG } from './desktop-launch.mjs';
import { validateLocalPath } from './path-open-utils.mjs';

/** Accept absolute directories from the CLI so Electron cannot resolve them elsewhere after changing its working directory. */
export const enqueueProjectOpenArguments = async (queue, argv) => {
  const directories = argv.filter((arg) => arg.startsWith(PROJECT_OPEN_ARG))
    .map((arg) => arg.slice(PROJECT_OPEN_ARG.length));
  if (directories.length > 1) throw new Error('Expected one project directory per launch.');
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) throw new Error('The project directory must be an absolute path.');
    const validated = await validateLocalPath(directory, 'Project directory');
    if (!validated.stats.isDirectory()) throw new Error('The project path must be a directory.');
    queue.push({ id: randomUUID(), directory: await fsp.realpath(validated.path) });
  }
  return directories.length > 0;
};
