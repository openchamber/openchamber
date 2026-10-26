import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The selected row's fill, the desktop's selection over the page. The
 * selection token is translucent, so it is painted as an inset shadow over
 * the row's own opaque background: a swipe's actions behind the row stay
 * hidden, which a translucent background let show through.
 */
export const MOBILE_ACTIVE_ROW_CLASS = 'shadow-[inset_0_0_0_100vmax_color-mix(in_srgb,var(--interactive-selection)_70%,transparent)]';

/** The selected row's title, in the selection's text colour as on the desktop. */
export const MOBILE_ACTIVE_TITLE_CLASS = 'text-interactive-selection-foreground';

// Inline minimums beat mobile.css's 36px floor for buttons, so a chevron or a
// swipe action keeps the size its row gives it.
const NO_TOUCH_FLOOR: React.CSSProperties = { touchAction: 'manipulation', minHeight: 0, minWidth: 0 };

/**
 * The chevron that opens what a row holds: always shown, as a phone has no
 * hover to reveal it, in a thumb-sized target around the 14px glyph.
 */
export const MobileRowChevron: React.FC<{
  expanded: boolean;
  /** Names what opens: a session's subsessions, a work's sessions, a run's lanes. */
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

/** A one-line row's chevron, in the slot left of its title. */
export const MobileSlotChevron: React.FC<{ slotLeft: number; children: React.ReactNode }> = ({ slotLeft, children }) => (
  // Centred on the 14px slot: 32px wide, 9px before it.
  <span className="absolute inset-y-0 z-10 flex items-center" style={{ insetInlineStart: slotLeft - 9 }}>
    {children}
  </span>
);

/**
 * A two-line row: the title line with the row's state and time, then a 16px
 * line with what the row belongs to. The chevron, when the row opens, is the
 * second line's first icon; it sits over the row rather than in its button,
 * so the two stay separate targets.
 */
export const MobileTwoLineLayout: React.FC<{
  indent: number;
  /** Absent while the row is being renamed: the first line is then the editor. */
  onSelect?: () => void;
  ariaLabel?: string;
  chevron: React.ReactNode;
  firstLine: React.ReactNode;
  secondLine: React.ReactNode;
}> = ({ indent, onSelect, ariaLabel, chevron, firstLine, secondLine }) => {
  const lines = <>
    <span className="flex h-5 min-w-0 items-center gap-2">{firstLine}</span>
    <span className="flex h-4 min-w-0 items-center gap-1.5 text-muted-foreground">
      {chevron ? <span aria-hidden className="size-3.5 shrink-0" /> : null}
      {secondLine}
    </span>
  </>;
  const layoutClass = 'flex min-w-0 flex-1 flex-col gap-1 py-2.5 pe-3 text-start';
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
      {/* Centred on the second line's first icon: 10px padding, a 20px title
          line and a 4px gap put that line's middle 42px down. */}
      {chevron ? (
        <span className="absolute z-10 flex h-8 items-center" style={{ insetInlineStart: indent - 9, top: 26 }}>{chevron}</span>
      ) : null}
    </div>
  );
};

/** One action a swipe reveals: an icon on the row's own background. */
export const MobileSwipeAction: React.FC<{
  icon: IconName;
  /** Drawn in place of the icon: a mark that is not in the sprite, such as a run's. */
  glyph?: React.ReactNode;
  label: string;
  revealed: boolean;
  onClick: () => void;
  tone?: 'default' | 'success' | 'destructive';
  /** A destructive action asking for its second tap. */
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
    {/* The check glyph draws smaller than the others at the same box. */}
    {glyph ?? <Icon name={icon} className={icon === 'check' ? 'size-5' : 'size-[18px]'} />}
  </button>
);

/**
 * Show more / Show fewer under a list, aligned with the text of its rows, a
 * step quieter than the muted titles above it, as on the desktop.
 */
export const MobileShowControl: React.FC<{ more: boolean; indent: number; onClick: () => void }> = ({ more, indent, onClick }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="flex min-h-9 w-full items-center gap-2 py-1 pe-3 text-start text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ paddingInlineStart: indent, touchAction: 'manipulation' }}
      onClick={onClick}
    >
      <Icon name={more ? 'arrow-down-s' : 'arrow-up-s'} className="size-4" />
      <span className="typography-micro">{t(more ? 'sessions.sidebar.group.showMore' : 'sessions.sidebar.group.showFewer')}</span>
    </button>
  );
};
