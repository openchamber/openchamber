import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { SESSION_TIMESTAMP_LABELS } from '@/lib/activityTimestampFormat';

const DISPLAY_OPTIONS = [
  ['off', 'activityTime.display.off'],
  ['hover', 'activityTime.display.hover'],
  ['inline', 'activityTime.display.inline'],
] as const;

/** The sidebar display menu's Session times submenu: where times show, which, the sort and how durations count. */
export const SessionTimestampSortMenu: React.FC = () => {
  const { t } = useI18n();
  const sort = useSessionDisplayStore((state) => state.sessionTimestampSort);
  const setSort = useSessionDisplayStore((state) => state.setSessionTimestampSort);
  const times = useSessionDisplayStore((state) => state.sessionTimes);
  const setTimes = useSessionDisplayStore((state) => state.setSessionTimes);
  const check = <Icon name="check" className="h-4 w-4 text-primary" />;
  const item = (key: string, label: string, checked: boolean, onClick: () => void) => (
    <DropdownMenuItem key={key} closeOnClick={false} onClick={onClick} className="flex items-center justify-between">
      <span className="flex-1">{label}</span>{checked ? check : null}
    </DropdownMenuItem>
  );
  return <DropdownMenuSub>
    <DropdownMenuSubTrigger>{t('activityTime.menu')}</DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="min-w-[200px]">
      {DISPLAY_OPTIONS.map(([display, label]) => item(display, t(label), times.display === display, () => setTimes({ display })))}
      {times.display !== 'off' ? <>
        <DropdownMenuSeparator />
        {SESSION_TIMESTAMP_LABELS.map(([field, label]) => item(`show-${field}`, t(label), times.fields.includes(field), () => setTimes({
          fields: times.fields.includes(field) ? times.fields.filter((value) => value !== field) : [...times.fields, field],
        })))}
      </> : null}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('activityTime.sort')}</DropdownMenuLabel>
      {item('lifecycle', t('activityTime.lifecycle'), sort.field === 'lifecycle', () => setSort({ ...sort, field: 'lifecycle' }))}
      {SESSION_TIMESTAMP_LABELS.map(([field, label]) => item(`sort-${field}`, t(label), sort.field === field, () => setSort({ ...sort, field })))}
      {sort.field !== 'lifecycle' ? (['desc', 'asc'] as const).map((direction) => item(direction, t(direction === 'asc' ? 'activityTime.asc' : 'activityTime.desc'), sort.direction === direction, () => setSort({ ...sort, direction }))) : null}
      <DropdownMenuSeparator />
      {item('last-run', t('activityTime.lastRunWhenIdle'), times.lastRunWhenIdle, () => setTimes({ lastRunWhenIdle: !times.lastRunWhenIdle }))}
      {item('since-input', t('activityTime.countFromInput'), times.countFromInput, () => setTimes({ countFromInput: !times.countFromInput }))}
    </DropdownMenuSubContent>
  </DropdownMenuSub>;
};
