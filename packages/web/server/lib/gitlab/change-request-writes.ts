import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { MutationContextInput } from '../source-control/binding-service-contracts.js';
import type { createGitLabResourceService } from './resources.js';

type Service = ReturnType<typeof createGitLabResourceService>;
type NumberedTarget = { projectId: string; number: number };
type Resolved = { providerTarget: NumberedTarget; target: SourceControlMutationTarget };
type RequestText = (value: SourceControlJson | undefined) => string;
type InvalidMutationContext = (message: string) => Error;
type Outcome = { state: string; result?: object };
type DigestInput = { digest: Record<string, SourceControlJson | undefined> };

export type ChangeRequestWriteInputs = {
  '/pr/base': DigestInput & { base: string };
  '/pr/rebase': DigestInput & { expectedHeadSha: string };
};
export type ChangeRequestWriteRoute = keyof ChangeRequestWriteInputs;

const HEAD_SHA = /^[0-9a-f]{40}$/;

const headChanged = () => Object.assign(new Error('GitLab merge request head changed'), { status: 409 });

const rebaseHead = (
  input: SourceControlJsonObject, context: MutationContextInput, requestText: RequestText, invalidMutationContext: InvalidMutationContext,
) => {
  const expectedHeadSha = requestText(input.expectedHeadSha);
  if (!HEAD_SHA.test(expectedHeadSha)) {
    throw invalidMutationContext('expectedHeadSha is required and must be a 40-character lowercase hex SHA');
  }
  if (context.target.headSha !== undefined && context.target.headSha !== expectedHeadSha) {
    throw invalidMutationContext('expectedHeadSha does not match the target head');
  }
  return expectedHeadSha;
};

export const changeRequestBaseEntry = (requestText: RequestText, invalidMutationContext: InvalidMutationContext) => ({
  kind: 'change-request-base',
  normalize: (input: SourceControlJsonObject, context: MutationContextInput) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    const base = requestText(input.base);
    if (!base || base.length > 256) throw invalidMutationContext('base is required and must fit 256 characters');
    return { base, digest: { base } };
  },
  perform: (service: Pick<Service, 'setChangeRequestBase'>, normalized: { base: string }, resolved: Resolved) => service.setChangeRequestBase({
    base: normalized.base,
    providerTarget: resolved.providerTarget,
    targetProject: resolved.target.project,
    expectedTarget: resolved.target,
  }),
  reconcile: (service: Pick<Service, 'reconcileChangeRequestBase'>, resolved: Resolved, normalized: { base: string }) =>
    service.reconcileChangeRequestBase(resolved.providerTarget, normalized.base),
});

export const changeRequestRebaseEntry = (requestText: RequestText, invalidMutationContext: InvalidMutationContext) => ({
  kind: 'change-request-rebase',
  normalize: (input: SourceControlJsonObject, context: MutationContextInput) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    const expectedHeadSha = rebaseHead(input, context, requestText, invalidMutationContext);
    return { expectedHeadSha, digest: { expectedHeadSha } };
  },
  perform: (service: Pick<Service, 'rebaseChangeRequest'>, normalized: DigestInput & { expectedHeadSha: string }, resolved: Resolved) => {
    if (resolved.target.headSha !== normalized.expectedHeadSha) throw headChanged();
    return service.rebaseChangeRequest({ providerTarget: resolved.providerTarget });
  },
  reconcile: (service: Pick<Service, 'reconcileRebaseMutation'>, resolved: Resolved): Outcome | Promise<Outcome> =>
    service.reconcileRebaseMutation(resolved.providerTarget),
});

export const changeRequestWriteEntries = (requestText: RequestText, invalidMutationContext: InvalidMutationContext) => ({
  '/pr/base': changeRequestBaseEntry(requestText, invalidMutationContext),
  '/pr/rebase': changeRequestRebaseEntry(requestText, invalidMutationContext),
});
