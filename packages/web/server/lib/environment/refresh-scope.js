import { AsyncLocalStorage } from 'node:async_hooks';

const userActionScope = new AsyncLocalStorage();

export const runAsUserAction = (work) => userActionScope.run(true, work);

export const isUserAction = () => userActionScope.getStore() === true;
