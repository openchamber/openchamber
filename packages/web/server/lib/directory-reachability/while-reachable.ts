import { directoryReachability, directoryUnreachableError } from './index.js';

const RECHECK_MS = 3000;

export const whileReachable = <Result>(
  directory: string,
  task: () => Promise<Result>,
  { checkDirectory = directoryReachability.check, recheckMs = RECHECK_MS } = {},
) => new Promise<Result>((resolve, reject) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const finish = (settle: () => void) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    settle();
  };
  const watch = () => {
    timer = setTimeout(async () => {
      if (await checkDirectory(directory) === 'unreachable') finish(() => reject(directoryUnreachableError(directory)));
      else if (!done) watch();
    }, recheckMs);
  };
  void (async () => {
    if (await checkDirectory(directory) === 'unreachable') throw directoryUnreachableError(directory);
    watch();
    return task();
  })().then((result) => finish(() => resolve(result)), (error) => finish(() => reject(error)));
});
