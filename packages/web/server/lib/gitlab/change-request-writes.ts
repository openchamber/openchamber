import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { MutationContextInput } from '../source-control/binding-service-contracts.js';
import type { createGitLabResourceService } from './resources.js';

type Service = ReturnType<typeof createGitLabResourceService>;
type NumberedTarget = { projectId: string; number: number };
type Resolved = { providerTarget: NumberedTarget; target: SourceControlMutationTarget };
type RequestText = (value: SourceControlJson | undefined) => string;
type InvalidMutationContext = (message: string) => Error;
type NameList = (value: SourceControlJson | undefined, limit: number) => string[];
type Outcome = { state: string; result?: object };
type DigestInput = { digest: Record<string, SourceControlJson | undefined> };

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

export const changeRequestRebaseEntry = (invalidMutationContext: InvalidMutationContext) => ({
  kind: 'change-request-rebase',
  normalize: (_input: SourceControlJsonObject, context: MutationContextInput) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    return { digest: {} };
  },
  perform: (service: Pick<Service, 'rebaseChangeRequest'>, _normalized: DigestInput, resolved: Resolved) =>
    service.rebaseChangeRequest({ providerTarget: resolved.providerTarget }),
  reconcile: (service: Pick<Service, 'reconcileRebaseMutation'>, resolved: Resolved): Outcome | Promise<Outcome> =>
    service.reconcileRebaseMutation(resolved.providerTarget, resolved.target.headSha),
});

export const issueAssigneesEntry = (nameList: NameList, limit: number, reviewerId: RegExp, invalidMutationContext: InvalidMutationContext) => ({
  kind: 'issue-assignees',
  normalize: (input: SourceControlJsonObject, context: MutationContextInput) => {
    if (!context.target.number) throw invalidMutationContext('target number is required');
    const names = nameList(input.assignees, limit);
    if (names.some((id) => !reviewerId.test(id))) throw invalidMutationContext('assignees are invalid');
    return { names, digest: { assignees: names } };
  },
  perform: (service: Pick<Service, 'setIssueAssignees'>, normalized: { names: string[] }, resolved: Resolved) => service.setIssueAssignees({
    assignees: normalized.names,
    providerTarget: resolved.providerTarget,
    targetProject: resolved.target.project,
    expectedTarget: resolved.target,
  }),
  reconcile: (service: Pick<Service, 'reconcileIssueAssignees'>, resolved: Resolved, normalized: { names: string[] }) =>
    service.reconcileIssueAssignees(resolved.providerTarget, normalized.names),
});
