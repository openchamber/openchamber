import { WorkflowAgentStopped } from './agent-session.js';

export const createLimiter = (limit) => {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  const acquire = (signal) => new Promise((resolve, reject) => {
    const grant = () => {
      signal.removeEventListener('abort', cancel);
      active += 1;
      resolve(release);
    };
    const cancel = () => {
      const index = queue.indexOf(grant);
      if (index !== -1) queue.splice(index, 1);
      reject(new WorkflowAgentStopped());
    };
    if (signal.aborted) return cancel();
    if (active < limit) return grant();
    queue.push(grant);
    signal.addEventListener('abort', cancel, { once: true });
  });
  return { acquire };
};
