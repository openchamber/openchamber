/**
 * The bound repository network's rule for a change request (a pull or merge
 * request), the same on every host: the request is in reach when the
 * repository it targets is a member of the network. The repository its head
 * comes from is not checked. A contributor's fork is reached through the
 * request itself, which the host already authorises for the token: the
 * host serves the head under the target repository (GitHub, Gitea
 * `refs/pull/<n>/head`, GitLab `refs/merge-requests/<n>/head`), so a
 * maintainer's upstream clone reads, reviews and merges it like any other.
 *
 * Creating a change request is the other direction: its head is a local
 * remote, and each provider still requires that remote to be in the network.
 *
 * @template Member, Target
 * @param {readonly Member[] | null | undefined} network the members of the bound network
 * @param {Target} target the repository the change request targets, as the provider names it
 * @param {(member: Member, target: Target) => boolean} isTarget whether a member is that repository
 * @returns {Member | null} the member the request targets, or null for a request outside the network
 */
export function changeRequestNetworkTarget(network, target, isTarget) {
  if (!Array.isArray(network)) return null;
  return network.find((member) => isTarget(member, target)) ?? null;
}
