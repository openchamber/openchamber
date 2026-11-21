export function changeRequestNetworkTarget<Member, Target>(
  network: readonly Member[] | null | undefined,
  target: Target,
  isTarget: (member: Member, target: Target) => boolean,
) {
  if (!Array.isArray(network)) return null;
  return network.find((member) => isTarget(member, target)) ?? null;
}
