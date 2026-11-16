import type { TrackerContainer, TrackerMappingResult } from './types';

export function resolveTrackerMappedProjectPath(
  mapping: TrackerMappingResult | null | undefined,
  container: TrackerContainer | null | undefined,
): string | null {
  if (!mapping || mapping.connected === false) {
    return null;
  }
  const containers = mapping.containers;
  if (container?.id) {
    const byId = containers.find((entry) => entry.id === container.id);
    if (byId?.projectPath) {
      return byId.projectPath;
    }
  }
  if (container?.key) {
    const byKey = containers.find((entry) => entry.key === container.key);
    if (byKey?.projectPath) {
      return byKey.projectPath;
    }
  }
  return mapping.defaultProjectPath?.trim() || null;
}
