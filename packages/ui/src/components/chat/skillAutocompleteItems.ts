import { fuzzyMatch } from '@/lib/utils';
import { rankByQuery } from '@/lib/search/fuzzySearch';

interface SkillAutocompleteSearchItem {
  name: string;
  scope: string;
}

// Project skills stay above the rest; inside each group, name matches rank
// like the slash menu (prefix, word boundary, substring), then fuzzy-only hits.
export function rankSkillAutocompleteItems<T extends SkillAutocompleteSearchItem>(
  skills: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim();
  const matches = normalizedQuery
    ? skills.filter((skill) => fuzzyMatch(skill.name, normalizedQuery))
    : [...skills];
  matches.sort((a, b) => a.name.localeCompare(b.name));

  const rankGroup = (group: T[]): T[] => {
    if (!normalizedQuery) return group;
    const ranked = rankByQuery(group, normalizedQuery, (skill) => [skill.name]);
    const rankedSet = new Set(ranked);
    return [...ranked, ...group.filter((skill) => !rankedSet.has(skill))];
  };

  return [
    ...rankGroup(matches.filter((skill) => skill.scope === 'project')),
    ...rankGroup(matches.filter((skill) => skill.scope !== 'project')),
  ];
}
