import type { LinearIssueTeam, LinearMappingResult } from '@/lib/api/types';

export function resolveLinearMappedProjectPath(
  mapping: LinearMappingResult | null | undefined,
  team: LinearIssueTeam | null | undefined,
): string | null {
  if (!mapping || mapping.connected === false) {
    return null;
  }
  const teams = mapping.teams ?? [];
  if (team?.id) {
    const byId = teams.find((entry) => entry.id === team.id);
    if (byId?.projectPath) {
      return byId.projectPath;
    }
  }
  if (team?.key) {
    const byKey = teams.find((entry) => entry.key === team.key);
    if (byKey?.projectPath) {
      return byKey.projectPath;
    }
  }
  return mapping.defaultProjectPath?.trim() || null;
}

/** True when the mapping's team list is truncated: Linear held more teams than the pages fetched. */
export function linearMappingTeamsTruncated(
  mapping: LinearMappingResult | null | undefined,
): boolean {
  return mapping?.teamsMore === true;
}

/** True when the empty-teams note applies: the fetched list is empty and complete. A truncated empty list says nothing about whether the workspace has teams, so the truncated note stands alone for it. */
export function linearMappingShowsEmptyTeamsNote(
  mapping: LinearMappingResult | null | undefined,
): boolean {
  return (mapping?.teams ?? []).length === 0 && !linearMappingTeamsTruncated(mapping);
}
