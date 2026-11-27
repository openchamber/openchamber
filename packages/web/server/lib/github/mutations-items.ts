import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { MutationCompletion } from '../source-control/mutation-storage.js';
import type { Octokit } from './contracts.js';
import type { GitHubMutationInput } from './mutations.js';

const CLOSE_REASON_OF: Readonly<Record<string, 'completed' | 'not_planned'>> = Object.freeze({
  completed: 'completed', not_planned: 'not_planned', duplicate: 'not_planned',
});

type ItemState = 'open' | 'closed';
type Project = Pick<SourceControlMutationTarget['project'], 'owner' | 'name'>;
type DigestOf = <Fields extends { target: SourceControlMutationTarget }>(fields: Fields) => string;
type MutationError = (message: string) => Error;
type SetState = (update: () => Promise<{ data?: { state?: string } }>, state: ItemState) => Promise<{ state: ItemState }>;
type NameList = (value: SourceControlJson | undefined, name: string, limit: number) => string[];

interface AssigneeDeps {
  rejected(operation: () => Promise<AssigneeAnswer>): Promise<AssigneeAnswer>;
  invalidProviderPayload(message: string): Error;
  sameNames(left: string[], right: string[]): boolean;
}

interface AssigneeAnswer { data?: { assignees?: Array<{ login: string }> } }

interface PerformStateDeps {
  setState: SetState;
  invalidProviderPayload(message: string): Error;
}

interface StateDeps {
  unknownOutcome(): MutationCompletion;
  definiteFailure(code: string): MutationCompletion;
}

interface ReconcileAssigneeDeps {
  invalidProviderPayload(message: string): Error;
  sameNames(left: string[], right: string[]): boolean;
  unknownOutcome(): MutationCompletion;
}

type IssueStateFields = {
  owner: string; repo: string; issue_number: number; state: ItemState; state_reason?: 'completed' | 'not_planned';
};

const targetNumber = (target: SourceControlMutationTarget) => {
  if (target.number === undefined) throw new TypeError('GitHub mutation target number is missing');
  return target.number;
};

const assigneesOf = (input: GitHubMutationInput) => {
  if (!input.assignees) throw new TypeError('GitHub assignees are missing');
  return input.assignees;
};

const stateOf = (input: GitHubMutationInput): ItemState => {
  if (input.state !== 'open' && input.state !== 'closed') throw new TypeError('GitHub issue state is missing');
  return input.state;
};

const closeReasonOf = (value: GitHubMutationInput['reason']) =>
  (value === 'completed' || value === 'not_planned' ? value : undefined);

const itemsState = (value: SourceControlJson | undefined): ItemState | null =>
  (value === 'open' || value === 'closed' ? value : null);

export const normalizeStateOperation = (
  operation: string, body: SourceControlJsonObject, digestOf: DigestOf, mutationError: MutationError,
) => {
  const state = itemsState(body.state);
  if (state === null) throw mutationError('state is invalid');
  const reason = body.reason;
  if (reason !== undefined && (state === 'open' || operation !== 'issue-state')) throw mutationError('reason is invalid');
  if (reason === undefined) {
    return { input: { state }, digest: (target: SourceControlMutationTarget) => digestOf({ target, state }) };
  }
  if (reason !== 'completed' && reason !== 'not_planned') throw mutationError('reason is invalid');
  return { input: { state, reason }, digest: (target: SourceControlMutationTarget) => digestOf({ target, state, reason }) };
};

export const normalizeAssignees = (body: SourceControlJsonObject, limits: { reviewersMax: number }, digestOf: DigestOf, nameList: NameList) => {
  const assignees = nameList(body.assignees, 'assignees', limits.reviewersMax);
  return { input: { assignees }, digest: (target: SourceControlMutationTarget) => digestOf({ target, assignees }) };
};

export const performAssignees = async (
  octokit: Octokit, project: Project, target: SourceControlMutationTarget, input: GitHubMutationInput, deps: AssigneeDeps,
) => {
  const updated = (await deps.rejected(() => octokit.rest.issues.update({
    owner: project.owner, repo: project.name, issue_number: targetNumber(target), assignees: assigneesOf(input),
  })))?.data;
  const people = updated?.assignees;
  if (!Array.isArray(people)) throw deps.invalidProviderPayload('GitHub returned invalid assignees');
  if (!deps.sameNames(people.map((person) => person.login), assigneesOf(input))) {
    throw deps.invalidProviderPayload('GitHub returned unexpected assignees');
  }
  return {};
};

export const reconcileAssignees = async (
  octokit: Octokit, target: SourceControlMutationTarget, input: GitHubMutationInput, deps: ReconcileAssigneeDeps,
): Promise<MutationCompletion> => {
  const current = await octokit.rest.issues.get({ owner: target.project.owner, repo: target.project.name, issue_number: targetNumber(target) });
  const people = current?.data?.assignees;
  if (!Array.isArray(people)) throw deps.invalidProviderPayload('GitHub returned invalid assignees');
  return deps.sameNames(people.map((person) => person.login), assigneesOf(input))
    ? { state: 'succeeded', result: {} } : deps.unknownOutcome();
};

export const performIssueState = async (
  octokit: Octokit, project: Project, target: SourceControlMutationTarget, input: GitHubMutationInput, deps: PerformStateDeps,
) => {
  const fields: IssueStateFields = {
    owner: project.owner, repo: project.name, issue_number: targetNumber(target), state: stateOf(input),
  };
  const reason = closeReasonOf(input.reason);
  if (reason !== undefined) fields.state_reason = reason;
  let storedReason: string | null | undefined;
  const result = await deps.setState(async () => {
    const response = await octokit.rest.issues.update(fields);
    storedReason = response?.data?.state_reason;
    return response;
  }, stateOf(input));
  if (reason !== undefined && CLOSE_REASON_OF[String(storedReason)] !== reason) {
    throw deps.invalidProviderPayload('GitHub returned an unexpected close reason');
  }
  return result;
};

export const reconcileIssueState = async (
  octokit: Octokit, target: SourceControlMutationTarget, input: GitHubMutationInput, deps: StateDeps,
): Promise<MutationCompletion> => {
  const current = await octokit.rest.issues.get({ owner: target.project.owner, repo: target.project.name, issue_number: targetNumber(target) });
  const state = current?.data?.state;
  if (state !== 'open' && state !== 'closed') return deps.unknownOutcome();
  if (state !== stateOf(input)) return deps.definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
  const reason = closeReasonOf(input.reason);
  if (reason !== undefined && CLOSE_REASON_OF[String(current?.data?.state_reason)] !== reason) return deps.unknownOutcome();
  return { state: 'succeeded', result: { state } };
};
