import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { MutationCompletion } from '../source-control/mutation-storage.js';
import type { Octokit, MutationPull } from './contracts.js';
import type { GitHubMutationInput, GitHubMutationTarget } from './mutations.js';
import type { JsonObject } from '../shared/json-values.js';

type MutationTarget = SourceControlMutationTarget;
type Project = Pick<MutationTarget['project'], 'owner' | 'name'>;
type DigestOf = <Fields extends { target: MutationTarget }>(fields: Fields) => string;
type MutationError = (message: string) => Error;
type RequiredText = (value: SourceControlJson | undefined, name: string) => string;
type ProviderString = (value: unknown) => value is string;
type Hash = string;

export const CHANGE_REQUEST_WRITE_ROUTES = Object.freeze({
  '/pr/base': 'base',
  '/pr/update-branch': 'update-branch',
  '/pr/rebase': 'rebase',
});

interface ChangeRequestWriteDeps {
  requireMutationPullRequest(raw: MutationPull | null | undefined, message: string, octokit: Octokit): MutationPull;
  sameProject(left: Project | null, right: Project): boolean;
  pullTargetProject(pull: MutationPull): Project;
  targetMatches(expected: Pick<MutationTarget, 'number' | 'head' | 'base' | 'headSha'>, pull: MutationPull): boolean;
  invalidProviderPayload(message: string): Error;
  rejected<Result>(operation: () => Promise<Result>): Promise<Result>;
  isProviderString: ProviderString;
  graphqlWrite(octokit: Octokit, query: string, variables: JsonObject): Promise<void>;
}

const validHeadSha = (isProviderString: ProviderString) => (value: SourceControlJson | undefined): value is Hash =>
  isProviderString(value) && /^[0-9a-f]{40}$/.test(value);

export const normalizeChangeRequestWrite = (
  operation: string, body: SourceControlJsonObject, context: { target: { headSha?: string } },
  digestOf: DigestOf, mutationError: MutationError, requiredText: RequiredText, isProviderString: ProviderString,
) => {
  if (operation === 'base') {
    const base = requiredText(body.base, 'base');
    if (base.length > 256 || base.startsWith('refs/heads/')) throw mutationError('base is invalid');
    return { input: { base }, digest: (target: MutationTarget) => digestOf({ target, base }) };
  }
  if (operation === 'update-branch' || operation === 'rebase') {
    const { expectedHeadSha } = body;
    if (!validHeadSha(isProviderString)(expectedHeadSha)) throw mutationError('expectedHeadSha is invalid');
    if (context.target.headSha !== undefined && context.target.headSha !== expectedHeadSha) {
      throw mutationError('expectedHeadSha does not match the target head');
    }
    return { input: { expectedHeadSha }, digest: (target: MutationTarget) => digestOf({ target, expectedHeadSha }) };
  }
  return undefined;
};

export const baseReconciled = (pull: MutationPull, input: GitHubMutationInput): MutationCompletion | undefined =>
  (pull.base.ref === input.base ? { state: 'succeeded', result: {} } : undefined);

export const performChangeRequestWrite = async (
  operation: string,
  octokit: Octokit,
  project: Project,
  target: MutationTarget,
  input: GitHubMutationInput,
  deps: ChangeRequestWriteDeps,
  providerTarget: Pick<GitHubMutationTarget, 'pullRequestId'> = {},
) => {
  if (operation === 'base') {
    const updated = deps.requireMutationPullRequest((await octokit.rest.pulls.update({
      owner: project.owner, repo: project.name, pull_number: target.number, base: input.base,
    }))?.data, 'GitHub returned an invalid updated pull request', octokit);
    if (!deps.sameProject(deps.pullTargetProject(updated), project)
      || !deps.targetMatches(input.base === undefined ? target : { ...target, base: input.base }, updated)) {
      throw deps.invalidProviderPayload('GitHub returned an updated pull request with an unexpected base');
    }
    return {};
  }
  if (operation === 'rebase') {
    const { pullRequestId } = providerTarget;
    if (!deps.isProviderString(pullRequestId) || !pullRequestId) {
      throw deps.invalidProviderPayload('GitHub returned an invalid pull request id');
    }
    await deps.graphqlWrite(
      octokit,
      'mutation($input: UpdatePullRequestBranchInput!) { updatePullRequestBranch(input: $input) { clientMutationId } }',
      { input: { pullRequestId, expectedHeadOid: input.expectedHeadSha, updateMethod: 'REBASE' } },
    );
    return {};
  }
  await deps.rejected(() => octokit.rest.pulls.updateBranch({
    owner: project.owner, repo: project.name, pull_number: target.number, expected_head_sha: input.expectedHeadSha,
  }));
  return {};
};

// external: https://docs.github.com/en/graphql/reference/mutations#updatepullrequestbranch GitHub exposes a rebase only through GraphQL
export const reconcileUpdateBranch = async (
  octokit: Octokit,
  target: MutationTarget,
  deps: {
    requireMutationPullRequest(raw: MutationPull | null | undefined, message: string, octokit: Octokit): MutationPull;
    unknownOutcome(): MutationCompletion;
  },
): Promise<MutationCompletion> => {
  await deps.requireMutationPullRequest(
    (await octokit.rest.pulls.get({ owner: target.project.owner, repo: target.project.name, pull_number: target.number }))?.data,
    'GitHub returned an invalid pull request',
    octokit,
  );
  return deps.unknownOutcome();
};
