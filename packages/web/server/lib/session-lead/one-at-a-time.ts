export const createOneAtATime = () => {
  const tails = new Map<string, Promise<unknown>>();
  return <Result>(key: string, task: () => Promise<Result>) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => undefined);
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return run;
  };
};
