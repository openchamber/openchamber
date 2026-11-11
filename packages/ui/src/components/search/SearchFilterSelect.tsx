import React from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import type { OmniAuthor, OmniFilters, OmniLifecycle, OmniSearchIn } from '@/lib/search/omniQuery';

const options = {
  lifecycle: ['active', 'archived', 'all'] as const,
  searchIn: ['everything', 'titles'] as const,
  author: ['any', 'user', 'assistant'] as const,
};
const optionKeys = {
  active: 'search.omni.lifecycle.active',
  archived: 'search.omni.lifecycle.archived',
  all: 'search.omni.lifecycle.all',
  everything: 'search.omni.searchIn.everything',
  titles: 'search.omni.searchIn.titles',
  any: 'search.omni.author.any',
  user: 'search.omni.author.user',
  assistant: 'search.omni.author.assistant',
  reasoning: 'search.omni.author.reasoning',
} as const;
export const SearchFilterSelect: React.FC<{ filter: keyof Pick<OmniFilters, 'lifecycle' | 'searchIn' | 'author'>; value: OmniLifecycle | OmniSearchIn | OmniAuthor; onChange: (value: string) => void }> = ({ filter, value, onChange }) => {
  const { t } = useI18n();
  const label = (option: OmniLifecycle | OmniSearchIn | OmniAuthor) => t(optionKeys[option]);
  return <Select value={value} onValueChange={onChange}><SelectTrigger data-search-filter={filter} aria-label={t(`search.omni.${filter}.label`)} className="w-fit max-w-48"><SelectValue>{label(value)}</SelectValue></SelectTrigger><SelectContent data-search-filter-panel={filter}>{options[filter].map((option) => <SelectItem data-search-filter-option={`${filter}:${option}`} key={option} value={option}>{label(option)}</SelectItem>)}</SelectContent></Select>;
};
