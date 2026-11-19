import { AsyncLocalStorage } from 'node:async_hooks';

const userActionScope = new AsyncLocalStorage<boolean>();

export const runAsUserAction = <T>(work: () => T) => userActionScope.run(true, work);

export const isUserAction = () => userActionScope.getStore() === true;
