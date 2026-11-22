export function changeRequestNetworkTarget<Member, Target>(
  network: readonly Member[] | null | undefined,
  target: Target,
  isTarget: (member: Member, target: Target) => boolean,
) {
  if (!Array.isArray(network)) return null;
  return network.find((member) => isTarget(member, target)) ?? null;
}

/**
 * Fork rule, kept until the owner decides: an existing GitLab merge request is
 * in reach only when its source project is in the network too (fork main's
 * gitlab/resources.js `requireNetwork`). Upstream checks the target alone (the
 * network rule in DOCUMENTATION.md); returning true here adopts that rule.
 */
export function changeRequestSourceInNetwork<Member, Source>(
  network: readonly Member[] | null | undefined,
  source: Source,
  isSource: (member: Member, source: Source) => boolean,
) {
  return Array.isArray(network) && network.some((member) => isSource(member, source));
}
