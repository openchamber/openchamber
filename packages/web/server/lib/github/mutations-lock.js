const SUBSCRIPTION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) { ... on Subscribable { viewerSubscription } }
  }
}`;

export const normalizeConversationWrite = (operation, body, digestOf, mutationError) => {
  if (operation === 'issue-lock' || operation === 'change-request-lock') {
    if (body.locked !== true && body.locked !== false) throw mutationError('locked is invalid');
    const { locked } = body;
    return { input: { locked }, digest: (target) => digestOf({ target, locked }) };
  }
  if (operation !== 'issue-subscription' && operation !== 'change-request-subscription') return null;
  if (body.subscribed !== true && body.subscribed !== false) throw mutationError('subscribed is invalid');
  const { subscribed } = body;
  return { input: { subscribed }, digest: (target) => digestOf({ target, subscribed }) };
};

export const subscriptionTarget = (operation, item, optionalText, invalidProviderPayload) => {
  if (operation !== 'issue-subscription' && operation !== 'change-request-subscription') return {};
  const subscribableId = optionalText(item?.node_id, 'node id', true);
  if (!subscribableId) throw invalidProviderPayload('GitHub returned an invalid node id');
  return { subscribableId };
};

export const performConversationWrite = async (octokit, operation, input, { providerTarget, target }, { rejected, graphqlWrite }) => {
  if (operation === 'issue-lock' || operation === 'change-request-lock') {
    const fields = { owner: target.project.owner, repo: target.project.name, issue_number: target.number };
    await rejected(() => (input.locked ? octokit.rest.issues.lock(fields) : octokit.rest.issues.unlock(fields)));
    return {};
  }
  await graphqlWrite(
    octokit,
    'mutation($subscribableId: ID!, $state: SubscriptionState!) { updateSubscription(input: { subscribableId: $subscribableId, state: $state }) { clientMutationId } }',
    { subscribableId: providerTarget.subscribableId, state: input.subscribed ? 'SUBSCRIBED' : 'UNSUBSCRIBED' },
  );
  return {};
};

export const reconcileConversationWrite = async (octokit, operation, target, input, unknownOutcome) => {
  if (operation === 'issue-lock' || operation === 'change-request-lock') {
    const current = await octokit.rest.issues.get({ owner: target.project.owner, repo: target.project.name, issue_number: target.number });
    return current?.data?.locked === input.locked ? { state: 'succeeded', result: {} } : unknownOutcome();
  }
  const data = await octokit.graphql(SUBSCRIPTION_QUERY, { owner: target.project.owner, name: target.project.name, number: target.number });
  return data?.repository?.issueOrPullRequest?.viewerSubscription === (input.subscribed ? 'SUBSCRIBED' : 'UNSUBSCRIBED')
    ? { state: 'succeeded', result: {} }
    : unknownOutcome();
};
