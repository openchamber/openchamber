/**
 * Turns a provider readiness verdict into the ordered list of things a person has to do
 * before that provider works. A bare failure code answers "what is wrong" but not "how
 * far along am I and what is next", which is the only question someone setting this up
 * for the first time actually has.
 *
 * The step list is fixed per provider and ordered by dependency, so the surface can show
 * the whole path up front. Everything before the blocking step is satisfied by
 * definition: the provider checks them in this same order and stops at the first failure.
 */

const STEPS = Object.freeze({
  docker: ['cli', 'daemon'],
  kubernetes: ['cli', 'cluster', 'namespace', 'permissions', 'isolation'],
  'apple-container': ['platform', 'cli'],
});

// Which step a failure code belongs to. Codes absent here block the first step, because
// an unclassified failure is not evidence that anything earlier succeeded.
const BLOCKING_STEP = Object.freeze({
  WORKSPACE_PROVIDER_UNSUPPORTED: 'platform',
  WORKSPACE_PROVIDER_CLI_MISSING: 'cli',
  WORKSPACE_PROVIDER_DAEMON_UNAVAILABLE: 'daemon',
  WORKSPACE_PROVIDER_NOT_CONFIGURED: 'cluster',
  WORKSPACE_PROVIDER_CLUSTER_UNREACHABLE: 'cluster',
  WORKSPACE_PROVIDER_NAMESPACE_MISSING: 'namespace',
  WORKSPACE_PROVIDER_RBAC_DENIED: 'permissions',
  WORKSPACE_PROVIDER_INGRESS_CONTROLLER_MISSING: 'permissions',
  WORKSPACE_PROVIDER_NETWORK_POLICY_UNENFORCED: 'isolation',
  WORKSPACE_PROVIDER_CAPABILITY_UNAVAILABLE: 'cli',
});

// Steps the app can complete on the person's behalf rather than instruct them to do.
const STEP_ACTIONS = Object.freeze({
  namespace: 'create-namespace',
  isolation: 'check-isolation',
});

export const WORKSPACE_SETUP_STEP_STATUS = Object.freeze({
  SATISFIED: 'satisfied',
  BLOCKED: 'blocked',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
});

/**
 * @param provider one of the secure workspace providers
 * @param verdict `{ available, code }` from the provider's own readiness check
 * @param isolation optional `{ verdict }` from the network isolation probe, which is too
 *        slow to run on every readiness check and is therefore reported separately
 */
export function workspaceSetupSteps(provider, verdict = {}, isolation = null) {
  const ids = STEPS[provider];
  if (!ids) return [];
  const available = verdict.available === true;
  const blockingIndex = available ? -1 : Math.max(0, ids.indexOf(BLOCKING_STEP[verdict.code] ?? ids[0]));

  return ids.map((id, index) => {
    const action = STEP_ACTIONS[id] ?? null;
    if (!available) {
      if (index < blockingIndex) return step(id, WORKSPACE_SETUP_STEP_STATUS.SATISFIED, action);
      if (index === blockingIndex) return step(id, WORKSPACE_SETUP_STEP_STATUS.BLOCKED, action, verdict.code);
      return step(id, WORKSPACE_SETUP_STEP_STATUS.PENDING, action);
    }
    // The provider reports availability without ever probing isolation, so a green
    // provider must not imply a green isolation step.
    if (id === 'isolation') {
      if (isolation?.verdict === 'enforced') return step(id, WORKSPACE_SETUP_STEP_STATUS.SATISFIED, action);
      if (isolation?.verdict === 'not-enforced') return step(id, WORKSPACE_SETUP_STEP_STATUS.BLOCKED, action, 'WORKSPACE_PROVIDER_NETWORK_POLICY_UNENFORCED');
      if (isolation?.verdict === 'inconclusive') return step(id, WORKSPACE_SETUP_STEP_STATUS.UNKNOWN, action, 'WORKSPACE_PROVIDER_ISOLATION_UNVERIFIED');
      return step(id, WORKSPACE_SETUP_STEP_STATUS.UNKNOWN, action);
    }
    return step(id, WORKSPACE_SETUP_STEP_STATUS.SATISFIED, action);
  });
}

function step(id, status, action, code) {
  return { id, status, ...(action ? { action } : {}), ...(code ? { code } : {}) };
}
