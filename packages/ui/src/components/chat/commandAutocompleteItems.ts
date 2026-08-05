import { fuzzyMatch } from '@/lib/utils';

export interface CommandAutocompleteSearchItem {
  name: string;
  description?: string;
  searchAliases?: string[];
  isBuiltIn?: boolean;
  isSkill?: boolean;
}

function addSearchAliases<T extends CommandAutocompleteSearchItem>(winner: T, duplicate: T): T {
  const existingAliases = winner.searchAliases ?? [];
  const aliases = [
    ...existingAliases,
    ...(winner.name === duplicate.name ? [] : [duplicate.name]),
    ...(duplicate.description ? [duplicate.description] : []),
    ...(duplicate.searchAliases ?? []),
  ].filter((alias, index, values) => alias !== winner.description && values.indexOf(alias) === index);
  const unchanged = aliases.length === existingAliases.length
    && aliases.every((alias, index) => alias === existingAliases[index]);

  return unchanged ? winner : { ...winner, searchAliases: aliases };
}

/**
 * Precedence is local command, discovered skill, OpenCode skill-command, then
 * custom/plugin command. Identity matches session.command's case-sensitive lookup.
 */
export function mergeCommandAutocompleteItems<T extends CommandAutocompleteSearchItem>(
  builtIns: T[],
  commands: T[],
  skills: T[],
): T[] {
  const merged: T[] = [];
  const byName = new Map<string, { index: number; item: T; precedence: number }>();

  const addItems = (items: T[], getPrecedence: (item: T) => number) => {
    for (const item of items) {
      const precedence = getPrecedence(item);
      const identity = item.name;
      const existing = byName.get(identity);
      if (!existing) {
        byName.set(identity, { index: merged.length, item, precedence });
        merged.push(item);
        continue;
      }

      const winner = precedence > existing.precedence
        ? addSearchAliases(item, existing.item)
        : addSearchAliases(existing.item, item);
      merged[existing.index] = winner;
      byName.set(identity, {
        index: existing.index,
        item: winner,
        precedence: Math.max(existing.precedence, precedence),
      });
    }
  };

  addItems(builtIns, () => 3);
  addItems(commands, (item) => item.isBuiltIn ? 3 : item.isSkill ? 1 : 0);
  addItems(skills, () => 2);
  return merged;
}

export function commandMatchesSearch(command: CommandAutocompleteSearchItem, query: string): boolean {
  return fuzzyMatch(command.name, query)
    || Boolean(command.description && fuzzyMatch(command.description, query))
    || Boolean(command.searchAliases?.some((alias) => fuzzyMatch(alias, query)));
}
