import React from 'react';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

/**
 * Filter field for Settings list sidebars (agents, commands, skills). The list
 * keeps its own grouping and order; the query only hides rows that don't match.
 */
export const SettingsSidebarSearch: React.FC<{
  value: string;
  onChange: (value: string) => void;
}> = ({ value, onChange }) => {
  const { t } = useI18n();
  return (
    <div className="relative mt-3">
      <Icon
        name="search"
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange('');
          }
        }}
        placeholder={t('settings.common.sidebar.searchPlaceholder')}
        aria-label={t('settings.common.sidebar.searchPlaceholder')}
        className="h-8 pl-7 typography-meta"
      />
    </div>
  );
};

/** Shown in place of the list when a query hides every row. */
export const SettingsSidebarNoMatches: React.FC<{ query: string }> = ({ query }) => {
  const { t } = useI18n();
  return (
    <p className="px-2 py-6 text-center typography-meta text-muted-foreground">
      {t('settings.common.sidebar.noMatches', { query: query.trim() })}
    </p>
  );
};
