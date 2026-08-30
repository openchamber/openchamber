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
