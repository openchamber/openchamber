export type InstalledSourceEntry = {
  skillName: string;
  skillDir: string;
  sourceId: string;
  scope?: 'user' | 'project';
  source?: 'opencode' | 'agents';
  sourceRef?: string;
};
export function readInstalledSources(): Map<string, InstalledSourceEntry[]>;
export function appendInstalledSources(entries: InstalledSourceEntry[]): void;
export function removeInstalledSources(skillName: string): void;
export function isInstalledFromSource(
  provenanceByName: Map<string, InstalledSourceEntry[]>,
  skillName: string,
  sourceId: string,
  skillDir: string,
): boolean;
