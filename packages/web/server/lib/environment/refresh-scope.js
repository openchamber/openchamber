import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Marks work the user started (a commit, a checkout, a merge), as opposed to
 * reads the UI repeats on its own (Git status polling). Only marked work may
 * run a project's environment command; reads use what an earlier run left.
 * Git routes wrap their action handlers in `runAsUserAction`, so the Git
 * service needs no extra argument on every function between the route and
 * the spawn.
 */
const userActionScope = new AsyncLocalStorage();

export const runAsUserAction = (work) => userActionScope.run(true, work);

export const isUserAction = () => userActionScope.getStore() === true;
