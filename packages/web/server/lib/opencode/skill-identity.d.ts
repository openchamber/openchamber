export function readSkillIdSelector(
  value: string | string[] | null | undefined,
): { id: string | null; error: string | null };
export function selectSkillById<Skill extends { id?: string | null; name: string }>(
  skills: Skill[],
  id: string,
  name: string,
): Skill | null;
export function skillFolderToDelete(skillMdPath: string | null | undefined, managedRoots: string[]): string | null;
export function isSkillFolderName(name: string | null | undefined): boolean;
export function removeSkillFolder(folder: string): void;
