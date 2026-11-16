import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn } from '@/lib/utils';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from './sessionTreeGeometry';
import type { SessionRefLine } from './useSessionRefLines';

type SessionRowRenameProps = {
  sessionRowKey: string;
  depth: number;
  isTwoLineRow: boolean;
  isOneLineTimelineRow: boolean;
  isActive: boolean;
  repeat: boolean;
  timelineProject: ProjectEntry | null;
  tooltipProjectLabel: string | null;
  tooltipBranchLabel: string | null;
  branchInSpace: boolean;
  primaryRef: SessionRefLine | null;
  moreRefCount: number;
  goal: React.ReactNode;
  draft: string;
  setDraft: (value: string) => void;
  onSave: (titleOverride?: string) => void;
  onCancel: () => void;
  formRef: React.RefObject<HTMLFormElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
};

/** A row in rename mode: the title becomes the input and the rest of the row stays where it was. */
export function SessionRowRename({
  sessionRowKey,
  depth,
  isTwoLineRow,
  isOneLineTimelineRow,
  isActive,
  repeat,
  timelineProject,
  tooltipProjectLabel,
  tooltipBranchLabel,
  branchInSpace,
  primaryRef,
  moreRefCount,
  goal,
  draft,
  setDraft,
  onSave,
  onCancel,
  formRef,
  inputRef,
}: SessionRowRenameProps): React.ReactNode {
  const { t } = useI18n();
  const renameForm = (
    <form
      ref={formRef}
      data-session-rename-form={sessionRowKey}
      // Exactly one text line tall: the input and its two icon buttons must
      // not make the row taller than the title they replace.
      className="flex h-[1lh] w-full items-center gap-2 typography-ui-label"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
        autoFocus
        placeholder={t('sessions.sidebar.session.menu.rename')}
        onKeyDown={(event) => handleSessionRenameKeyDown(event, onCancel)}
      />
      <button
        type="submit"
        aria-label={t('sessions.sidebar.session.rename.save')}
        title={t('sessions.sidebar.session.rename.save')}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Icon name="check" className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('sessions.sidebar.session.rename.cancel')}
        title={t('sessions.sidebar.session.rename.cancel')}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Icon name="close" className="size-3.5" />
      </button>
    </form>
  );
  if (isTwoLineRow) {
    // Renaming keeps the whole card in place: the title line becomes the
    // input, project and branch stay where they were, the slot stays empty.
    return (
      <div
        // The virtual list's 1px margins apply to the row box, rename included.
        data-session-row-box=""
        style={{ paddingInlineStart: sessionDetailedRowPaddingLeft(depth) }}
        className={cn(
          'group relative my-0.5 flex items-center rounded-md pe-2.5',
          'py-1.5',
          isActive && !repeat && 'oc-selected text-interactive-selection-foreground',
        )}
      >
        <SessionTimelineRowBody
          compact={isOneLineTimelineRow}
          project={timelineProject}
          projectLabel={tooltipProjectLabel}
          title={renameForm}
          titleClassName="text-foreground"
          branchLabel={tooltipBranchLabel}
          spaceMark={branchInSpace ? t('sessions.sidebar.group.space') : null}
          statusDot={null}
          pinnedMarker={null}
          timeSlot={null}
          directoryIndicator={null}
          prBadge={primaryRef ? (
            <span
              className="inline-flex flex-shrink-0 items-center gap-1 typography-micro text-muted-foreground"
            >
              <Icon name={primaryRef.icon} className={cn('h-3 w-3', primaryRef.color && 'oc-ref-tint')} style={primaryRef.color ? refTintStyle(primaryRef.color) : undefined} />
              {isOneLineTimelineRow ? null : <>
                <span className="leading-none tabular-nums">{primaryRef.label}</span>
                {moreRefCount > 0 ? <span className="leading-none tabular-nums text-muted-foreground">+{moreRefCount}</span> : null}
              </>}
            </span>
          ) : null}
          zombieIndicator={null}
          goal={goal}
          badges={null}
          hideMetaOnHoverClass=""
        />
      </div>
    );
  }
  return (
    <div
          data-session-row-box=""
      style={{ paddingInlineStart: sessionTreeRowPaddingLeft(depth) }}
      // my-0.5 matches the normal row box so entering rename mode does not
      // shift the row vertically; the empty slot keeps the title in place.
      className="group relative my-0.5 flex items-center gap-1.5 rounded-md py-[5px] pe-2.5"
    >
      <span aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        {renameForm}
      </div>
    </div>
  );
}
