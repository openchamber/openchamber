import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { RowGuestMark } from '@/lib/guests/marks';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn } from '@/lib/utils';
import { GuestRowMarkLines } from './GuestRowMarks';
import { SidebarRefLinks } from './SidebarRefLinks';
import type { SessionRefLine } from './useSessionRefLines';

type SessionRowTooltipBodyProps = {
  sessionTitle: string;
  updatedLabel: string;
  compactUpdatedLabel: string;
  projectLabel: string | null;
  branchLabel: string | null;
  branchInSpace: boolean;
  branchPrIconColor: string | undefined;
  refLines: readonly SessionRefLine[];
  trackerDirectory: string | null;
  guestMarks: readonly RowGuestMark[];
  recap: string | null;
};

/** What the whole-row tooltip says: the title and time, project, branch, PR links, marks and the last recap. */
export function SessionRowTooltipBody({
  sessionTitle,
  updatedLabel,
  compactUpdatedLabel,
  projectLabel,
  branchLabel,
  branchInSpace,
  branchPrIconColor,
  refLines,
  trackerDirectory,
  guestMarks,
  recap,
}: SessionRowTooltipBodyProps): React.ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex min-w-44 flex-col gap-1.5 text-start text-xs">
      <div className="flex items-center justify-between gap-3">
        <span dir="auto" className="oc-ui-start-align min-w-0 truncate font-medium text-foreground">{sessionTitle}</span>
        <span className="flex-shrink-0 text-muted-foreground" title={updatedLabel}>{compactUpdatedLabel}</span>
      </div>
      {projectLabel ? (
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Icon name="folder" className="h-3 w-3 flex-shrink-0" />
          <span className="min-w-0 truncate">{projectLabel}</span>
        </div>
      ) : null}
      {branchLabel ? (
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {branchInSpace
            ? <Icon name="instance" className="h-3 w-3 flex-shrink-0" aria-hidden={false} role="img" aria-label={t('sessions.sidebar.group.space')} />
            : <Icon name="git-branch" className={cn('h-3 w-3 flex-shrink-0', branchPrIconColor && 'oc-ref-tint')} style={branchPrIconColor ? refTintStyle(branchPrIconColor) : undefined} />}
          <span className="min-w-0 truncate">{branchLabel}</span>
        </div>
      ) : null}
      {refLines.length > 0 ? <SidebarRefLinks items={refLines} directory={trackerDirectory} /> : null}
      {/* Every mark, not only those past the two drawn: on a one-line
          row the hover actions cover the cluster. */}
      {guestMarks.length > 0 ? <GuestRowMarkLines marks={guestMarks} /> : null}
      {recap ? (
        <p className="min-w-0 line-clamp-4 text-muted-foreground">{recap}</p>
      ) : null}
    </div>
  );
}
