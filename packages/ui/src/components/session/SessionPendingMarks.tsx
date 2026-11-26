import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { BlockingRequestKinds } from '@/sync/global-blocking-requests';

const MARKS = [
  {
    kind: 'permission',
    enabled: 'hasPermission',
    icon: 'shield',
    colorClass: 'text-status-warning',
    labelKey: 'sessions.sidebar.session.status.permissionRequired',
  },
  {
    kind: 'form',
    enabled: 'hasForm',
    icon: 'question',
    colorClass: 'text-status-question',
    labelKey: 'sessions.sidebar.session.status.questionPending',
  },
] as const satisfies ReadonlyArray<{
  kind: string;
  enabled: keyof BlockingRequestKinds;
  icon: IconName;
  colorClass: string;
  labelKey: I18nKey;
}>;

export const SessionPendingMarks: React.FC<BlockingRequestKinds & {
  className?: string;
  tooltip?: boolean;
}> = ({ hasPermission, hasForm, className, tooltip = false }) => {
  const { t } = useI18n();
  if (!hasPermission && !hasForm) return null;

  return (
    <>
      {MARKS.filter((mark) => (mark.enabled === 'hasPermission' ? hasPermission : hasForm)).map((mark) => {
        const label = t(mark.labelKey);
        const glyph = (
          <span
            className={cn('inline-flex shrink-0 items-center', className)}
            aria-label={label}
            title={tooltip ? undefined : label}
            data-session-pending-mark={mark.kind}
          >
            <Icon name={mark.icon} className={cn('size-3', mark.colorClass)} />
          </span>
        );
        if (!tooltip) return <React.Fragment key={mark.kind}>{glyph}</React.Fragment>;
        return (
          <Tooltip key={mark.kind}>
            <TooltipTrigger asChild>{glyph}</TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </>
  );
};
