import { digestMutationInput } from '../source-control/mutation-executor.js';

const LOCK_ROUTES = Object.freeze({ '/issues/lock': 'issue-lock', '/pr/lock': 'change-request-lock' });

export const withGiteaLock = (standardMutations) => Object.freeze({
  routes: Object.freeze([...standardMutations.routes, ...Object.keys(LOCK_ROUTES)]),
  prepare: (request) => {
    const kind = LOCK_ROUTES[request.route];
    if (!kind) return standardMutations.prepare(request);
    const { input, context, actor, credential } = request;
    if (!context.target.number || (input.locked !== true && input.locked !== false)) {
      throw Object.assign(new Error('target number and locked are required'), {
        code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400,
      });
    }
    return {
      kind,
      input: { locked: input.locked },
      digest: (target) => digestMutationInput({ kind, actor, credential, target, locked: input.locked }),
    };
  },
});
