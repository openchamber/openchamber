import type { OmniFilters } from '@/lib/search/omniQuery';

type ChipDefaults = Partial<Pick<OmniFilters, 'lifecycle' | 'searchIn' | 'author'>>;

const chipKeys = ['project', 'worktree', 'lifecycle', 'searchIn', 'author'] as const;

/** The option label for each value of the filters that have fixed values; the scope menu uses the same keys. */
export const SEARCH_FILTER_VALUE_LABEL_KEYS = {
  lifecycle: { active: 'search.omni.lifecycle.active', archived: 'search.omni.lifecycle.archived', all: 'search.omni.lifecycle.all' },
  searchIn: { everything: 'search.omni.searchIn.everything', titles: 'search.omni.searchIn.titles' },
  author: { any: 'search.omni.author.any', user: 'search.omni.author.user', assistant: 'search.omni.author.assistant', reasoning: 'search.omni.author.reasoning' },
} as const;

export function searchFilterChipKeys(filters: OmniFilters, defaults: ChipDefaults): Array<typeof chipKeys[number]> {
  return chipKeys.filter((key) => {
    const defaultValue = key === 'lifecycle' || key === 'searchIn' || key === 'author' ? defaults[key] : undefined;
    return filters[key] !== undefined && filters[key] !== defaultValue;
  });
}
