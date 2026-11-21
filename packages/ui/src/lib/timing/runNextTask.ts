export const runNextTask = (run: () => void): void => {
  window.setTimeout(run, 0);
};
