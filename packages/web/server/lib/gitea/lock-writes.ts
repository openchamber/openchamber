import { digestMutationInput } from '../source-control/mutation-executor.js';
import type { SourceControlMutationTarget } from '@openchamber/sdk';
import type { createStandardMutations } from '../source-control/standard-mutations.js';

type StandardMutations = ReturnType<typeof createStandardMutations>;
type PrepareRequest = Parameters<StandardMutations['prepare']>[0];

const lockKindOf = (route: string) => (route === '/issues/lock' ? 'issue-lock' : route === '/pr/lock' ? 'change-request-lock' : null);

export const withGiteaLock = (standardMutations: StandardMutations): StandardMutations => Object.freeze({
  routes: Object.freeze([...standardMutations.routes, '/issues/lock', '/pr/lock']),
  prepare: (request: PrepareRequest) => {
    const kind = lockKindOf(request.route);
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
      digest: (target: SourceControlMutationTarget) => digestMutationInput({ kind, actor, credential, target, locked: input.locked }),
    };
  },
});
