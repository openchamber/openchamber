import { whileReachable } from '../directory-reachability/while-reachable.js';
import { directoryReachability, directoryUnreachableError } from '../directory-reachability/index.js';

const PROJECT_BATCH_CONCURRENCY = 4;

export const readProjects = async <Entry>(
  directories: string[],
  readDirectory: (directory: string) => Promise<Entry>,
  failedDirectory: (directory: string, message: string) => Entry,
) => {
  const projects: Entry[] = [];
  const unreachable = await Promise.all(directories.map(directoryReachability.isUnreachable));
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= directories.length) return;
      const directory = directories[index];
      if (directory === undefined) continue;
      projects[index] = unreachable[index]
        ? failedDirectory(directory, directoryUnreachableError(directory).message)
        : await whileReachable(directory, () => readDirectory(directory))
          .catch((error) => failedDirectory(directory, error instanceof Error ? error.message : 'Failed to read project repository'));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROJECT_BATCH_CONCURRENCY, directories.length) }, worker));
  return projects.filter(Boolean);
};
