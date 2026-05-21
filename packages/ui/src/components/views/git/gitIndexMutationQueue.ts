export type GitIndexMutationDirection = 'stage' | 'unstage';

export type QueuedGitIndexMutation = {
  directory: string;
  direction: GitIndexMutationDirection;
  paths: Set<string>;
};

type MutationSnapshot = {
  directory: string;
  direction: GitIndexMutationDirection;
  paths: string[];
};

type GitIndexMutationQueueOptions = {
  runMutation: (mutation: MutationSnapshot) => Promise<void>;
  onMutationComplete: (mutation: MutationSnapshot) => void;
  onMutationError: (mutation: MutationSnapshot, error: unknown) => void;
  onPathsComplete: (paths: string[]) => void;
  scheduleFlush: () => void;
};

export type GitIndexMutationQueue = {
  enqueue: (mutation: QueuedGitIndexMutation) => void;
  flush: () => void;
  clear: () => void;
  size: () => number;
  isRunning: () => boolean;
};

export const createGitIndexMutationQueue = ({
  runMutation,
  onMutationComplete,
  onMutationError,
  onPathsComplete,
  scheduleFlush,
}: GitIndexMutationQueueOptions): GitIndexMutationQueue => {
  const queuedMutations: QueuedGitIndexMutation[] = [];
  let running = false;

  const flush = () => {
    if (running) {
      return;
    }

    const nextMutation = queuedMutations.shift();
    if (!nextMutation) {
      return;
    }

    running = true;
    const snapshot: MutationSnapshot = {
      directory: nextMutation.directory,
      direction: nextMutation.direction,
      paths: Array.from(nextMutation.paths),
    };

    void (async () => {
      try {
        await runMutation(snapshot);
        onMutationComplete(snapshot);
      } catch (error) {
        onMutationError(snapshot, error);
      } finally {
        onPathsComplete(snapshot.paths);
        running = false;
        if (queuedMutations.length > 0) {
          scheduleFlush();
        }
      }
    })();
  };

  return {
    enqueue: (mutation) => {
      const lastMutation = queuedMutations[queuedMutations.length - 1];
      if (lastMutation?.directory === mutation.directory && lastMutation.direction === mutation.direction) {
        mutation.paths.forEach((path) => lastMutation.paths.add(path));
        return;
      }

      queuedMutations.push(mutation);
    },
    flush,
    clear: () => {
      queuedMutations.length = 0;
    },
    size: () => queuedMutations.length,
    isRunning: () => running,
  };
};
