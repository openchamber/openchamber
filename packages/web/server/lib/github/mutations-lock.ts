import type { SourceControlMutationTarget } from '@openchamber/sdk';
import type { MutationCompletion } from '../source-control/mutation-storage.js';
import { isPlainObject } from './mappers.js';
import type { Octokit } from './contracts.js';
import type { GitHubMutationInput } from './mutations.js';
import type { SourceControlJson } from '@openchamber/sdk';
import type { JsonObject } from '../shared/json-values.js';

const SUBSCRIPTION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) { ... on Subscribable { viewerSubscription } }
  }
}`;


type DigestOf = <Fields extends { target: SourceControlMutationTarget }>(fields: Fields) => string;
type MutationError = (message: string) => Error;
type LockOperation = 'issue-lock' | 'change-request-lock';
type Outcome = MutationCompletion;

interface ConversationWriteDeps {
  rejected<Result>(operation: () => Promise<Result>): Promise<Result>;
  graphqlWrite(octokit: Octokit, query: string, variables: JsonObject): Promise<void>;
}

const fieldsOf = <Value>(value: Value): JsonObject | null => {
  if (!isPlainObject(value)) return null;
  // SAFETY: `isPlainObject` accepted a plain object, whose own fields are JSON values from the provider payload.
  return value as JsonObject;
};

const isLockOperation = (operation: string): operation is LockOperation =>
  operation === 'issue-lock' || operation === 'change-request-lock';

export const normalizeConversationWrite = (
  operation: string, body: JsonObject, digestOf: DigestOf, mutationError: MutationError,
) => {
  if (isLockOperation(operation)) {
    if (body.locked !== true && body.locked !== false) throw mutationError('locked is invalid');
    const { locked } = body;
    return { input: { locked }, digest: (target: SourceControlMutationTarget) => digestOf({ target, locked }) };
  }
  if (operation !== 'issue-subscription' && operation !== 'change-request-subscription') return null;
  if (body.subscribed !== true && body.subscribed !== false) throw mutationError('subscribed is invalid');
  const { subscribed } = body;
  return { input: { subscribed }, digest: (target: SourceControlMutationTarget) => digestOf({ target, subscribed }) };
};

type OptionalText = (value: SourceControlJson | undefined, name: string, trim?: boolean) => string | undefined;

export const subscriptionTarget = (
  operation: string, item: { node_id?: SourceControlJson } | null | undefined,
  optionalText: OptionalText, invalidProviderPayload: (message: string) => Error,
) => {
  if (operation !== 'issue-subscription' && operation !== 'change-request-subscription') return {};
  const subscribableId = optionalText(item?.node_id, 'node id', true);
  if (!subscribableId) throw invalidProviderPayload('GitHub returned an invalid node id');
  return { subscribableId };
};

export const performConversationWrite = async (
  octokit: Octokit,
  operation: string,
  input: GitHubMutationInput,
  { providerTarget, target }: { providerTarget: { subscribableId?: string | null }; target: SourceControlMutationTarget },
  deps: ConversationWriteDeps,
) => {
  if (isLockOperation(operation)) {
    const fields = { owner: target.project.owner, repo: target.project.name, issue_number: target.number };
    await deps.rejected(() => (input.locked === true ? octokit.rest.issues.lock(fields) : octokit.rest.issues.unlock(fields)));
    return {};
  }
  await deps.graphqlWrite(
    octokit,
    'mutation($subscribableId: ID!, $state: SubscriptionState!) { updateSubscription(input: { subscribableId: $subscribableId, state: $state }) { clientMutationId } }',
    { subscribableId: providerTarget.subscribableId ?? '', state: input.subscribed === true ? 'SUBSCRIBED' : 'UNSUBSCRIBED' },
  );
  return {};
};

export const reconcileConversationWrite = async (
  octokit: Octokit, operation: string, target: SourceControlMutationTarget, input: GitHubMutationInput,
  unknownOutcome: () => Outcome,
): Promise<Outcome> => {
  if (isLockOperation(operation)) {
    const current = await octokit.rest.issues.get({ owner: target.project.owner, repo: target.project.name, issue_number: target.number });
    return current?.data?.locked === (input.locked === true) ? { state: 'succeeded', result: {} } : unknownOutcome();
  }
  const data = await octokit.graphql(SUBSCRIPTION_QUERY, { owner: target.project.owner, name: target.project.name, number: target.number });
  const repository = fieldsOf(fieldsOf(data)?.repository);
  const item = fieldsOf(repository?.issueOrPullRequest);
  return item?.viewerSubscription === (input.subscribed === true ? 'SUBSCRIBED' : 'UNSUBSCRIBED')
    ? { state: 'succeeded', result: {} }
    : unknownOutcome();
};
