import React from 'react';
import type { SessionNode } from '@/components/session/sidebar/types';
import { CollapsedSessionActivityIndicator } from '@/components/session/sidebar/sessions/collapsedActivityIndicator';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const MOBILE_ACTIVE_ROW_CLASS = 'shadow-[inset_0_0_0_100vmax_var(--interactive-selection)]';

export const MOBILE_ACTIVE_TITLE_CLASS = 'text-interactive-selection-foreground';

const NO_TOUCH_FLOOR: React.CSSProperties = { touchAction: 'manipulation', minHeight: 0, minWidth: 0 };

export const MobileRowChevron: React.FC<{
  expanded: boolean;
  kind: 'session' | 'work' | 'run';
  label: string;
  onToggle: () => void;
}> = ({ expanded, kind, label, onToggle }) => {
  const { t } = useI18n();
  const ariaLabel = kind === 'session'
    ? (expanded ? t('sessions.sidebar.session.subsessions.collapse') : t('sessions.sidebar.session.subsessions.expand'))
    : kind === 'run'
      ? (expanded ? t('sessions.sidebar.run.collapse') : t('sessions.sidebar.run.expand'))
      : (expanded ? t('sessions.sidebar.group.collapseAria', { label }) : t('sessions.sidebar.group.expandAria', { label }));
  return (
    <button
      type="button"
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={NO_TOUCH_FLOOR}
      aria-label={ariaLabel}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <FileTreeChevron expanded={expanded} />
    </button>
  );
};

export const MobileSlotChevron: React.FC<{ slotLeft: number; children: React.ReactNode }> = ({ slotLeft, children }) => (
  <span className="absolute inset-y-0 z-10 flex items-center" style={{ insetInlineStart: slotLeft - 9 }}>
    {children}
  </span>
);

export const MobileTwoLineLayout: React.FC<{
  indent: number;
  onSelect?: () => void;
  ariaLabel?: string;
  chevron: React.ReactNode;
  firstLine: React.ReactNode;
  secondLine: React.ReactNode;
  secondLineEnd?: React.ReactNode;
}> = ({ indent, onSelect, ariaLabel, chevron, firstLine, secondLine, secondLineEnd }) => {
  const lines = <>
    <span className="flex h-5 min-w-0 items-center gap-2">{firstLine}</span>
    {secondLine || chevron ? <span className="flex h-4 min-w-0 items-center gap-1.5 text-muted-foreground">
      {chevron ? <span aria-hidden className="size-3.5 shrink-0" /> : null}
      {secondLine}
    </span> : null}
  </>;
  const layoutClass = 'flex min-h-9 min-w-0 flex-1 flex-col gap-1 pt-1.5 pb-2 pe-3 text-start';
  return (
    <div className="relative flex min-w-0 flex-1">
      {onSelect ? (
        <button
          type="button"
          className={cn(layoutClass, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring')}
          style={{ paddingInlineStart: indent, touchAction: 'manipulation' }}
          aria-label={ariaLabel}
          onClick={onSelect}
        >
          {lines}
        </button>
      ) : (
        <div className={layoutClass} style={{ paddingInlineStart: indent }}>{lines}</div>
      )}
      {chevron ? (
        <span className="absolute z-10 flex h-8 items-center" style={{ insetInlineStart: indent - 9, top: 22 }}>{chevron}</span>
      ) : null}
      {secondLineEnd ? (
        <span className="absolute inset-e-3 bottom-2 z-10 flex h-4 items-center gap-1.5">{secondLineEnd}</span>
      ) : null}
    </div>
  );
};

export const MobileSwipeAction: React.FC<{
  icon: IconName;
  glyph?: React.ReactNode;
  label: string;
  revealed: boolean;
  onClick: () => void;
  tone?: 'default' | 'success' | 'destructive';
  armed?: boolean;
  disabled?: boolean;
}> = ({ icon, glyph, label, revealed, onClick, tone = 'default', armed = false, disabled = false }) => (
  <button
    type="button"
    tabIndex={revealed ? 0 : -1}
    disabled={disabled}
    className={cn(
      'flex flex-1 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset disabled:opacity-40',
      tone === 'destructive'
        ? armed ? 'rounded-lg bg-destructive text-destructive-foreground focus-visible:ring-destructive' : 'text-[var(--status-error)] active:opacity-80 focus-visible:ring-destructive'
        : tone === 'success' ? 'text-status-success active:opacity-80 focus-visible:ring-ring' : 'text-muted-foreground active:text-foreground focus-visible:ring-ring',
    )}
    aria-label={label}
    onClick={onClick}
    style={{ touchAction: 'manipulation' }}
  >
    {glyph ?? <Icon name={icon} className={icon === 'check' ? 'size-5' : 'size-[18px]'} />}
  </button>
);

export const MobileShowControl: React.FC<{ more: boolean; fewer: boolean; hiddenNodes: SessionNode[]; indent: number; onShow: (control: 'more' | 'fewer') => void }> = ({ more, fewer, hiddenNodes, indent, onShow }) => {
  const { t } = useI18n();
  const control = (kind: 'more' | 'fewer') => (
    <button
      type="button"
      className="flex min-h-9 items-center gap-2 py-1 pe-3 text-start text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ touchAction: 'manipulation' }}
      onClick={() => onShow(kind)}
    >
      <Icon name={kind === 'more' ? 'arrow-down-s' : 'arrow-up-s'} className="size-4" />
      <span className="typography-micro">{t(kind === 'more' ? 'sessions.sidebar.group.showMore' : 'sessions.sidebar.group.showFewer')}</span>
      {kind === 'more' ? <CollapsedSessionActivityIndicator nodes={hiddenNodes} /> : null}
    </button>
  );
  return (
    <div className="flex w-full items-center gap-2" style={{ paddingInlineStart: indent }}>
      {more ? control('more') : null}
      {fewer ? control('fewer') : null}
    </div>
  );
};
