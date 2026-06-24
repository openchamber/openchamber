/**
 * Helpers for assembling the slash-command menu item list.
 */

/**
 * Merge command entries with skill entries for the slash-command menu, dropping
 * any command that shares a name with a skill.
 *
 * OpenCode registers skills as commands, and plugins (e.g. Oh My OpenAgent) can
 * register additional commands whose names collide with installed skills. Those
 * command entries reach the menu through the commands store while the skill is
 * also listed via the skills store, so without this filter the same skill
 * renders twice (#1550). This mirrors CommandsSidebar, which already hides
 * commands that are shadowed by a skill.
 *
 * Skill entries are kept (they carry the correct skill badge and metadata); only
 * the duplicate command entries are removed. Order is preserved: surviving
 * commands first, then skills.
 */
export function mergeCommandsWithSkills<T extends { name: string }>(
  commands: T[],
  skillItems: T[],
): T[] {
  const skillNames = new Set(skillItems.map((skill) => skill.name));
  const commandsWithoutSkillDuplicates = commands.filter((command) => !skillNames.has(command.name));
  return [...commandsWithoutSkillDuplicates, ...skillItems];
}
