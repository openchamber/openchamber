import { useState } from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { PetActionMessage, PetState, PetStateMessage } from '@/lib/pet/petContract';

// The single status bubble above the pet. Priority-resolved upstream (only one
// state is ever active), so this renders one of: a running caption, a permission
// prompt with Allow/Deny, a "ready for review" note, or a failure note.
//
// Mirrors Codex: it surfaces the most attention-worthy thread, not one bubble
// per session. Permission Allow/Deny is OpenChamber's extension — actions are
// relayed back to the main renderer (which owns the live sync) via `onAction`.
//
// The bubble is minimizable: collapsed, it shrinks to a small badge coloured by
// the dominant state with the per-state count, expanding back on click. The
// collapsed preference is intentionally sticky across state changes so a pet the
// user tucked away stays tucked — only the badge colour/count follows the state.

const CARD_MAX_WIDTH = 248;

// Visual accent keyed by dominant state, used by both the minimized badge
// (solid fill: bg/fg/border) and the expanded bubble (icon + iconColor before
// the title). The three attention states use status tokens (they ARE feedback);
// plain "running" stays neutral with a spinner so it doesn't shout like an alert.
type StateAccent = { bg: string; fg: string; border: string; icon: IconName; iconColor: string; spin?: boolean };

export function PetBubble({
  message,
  onAction,
}: {
  message: PetStateMessage;
  onAction: (action: PetActionMessage) => void;
}) {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const [minimized, setMinimized] = useState(false);

  if (message.state === 'idle') return null;

  const approval = message.approvals[0] ?? null;
  const thread = message.thread;
  const sessionId = thread?.sessionId || approval?.sessionId || '';
  const title = (thread?.title || approval?.sessionTitle || '').trim() || t('mobile.sessions.untitled');

  // A permission can be answered inline; a question is too complex for the
  // bubble, so it (and every other state) just opens the session in the app.
  const permission = message.state === 'waiting' && approval?.kind === 'permission' ? approval : null;

  const focusSession = () => {
    if (sessionId) onAction({ type: 'focus-session', sessionId });
  };

  const accentFor = (state: PetState): StateAccent => {
    const colors = currentTheme.colors;
    if (state === 'failed') {
      return { bg: colors.status.error, fg: colors.status.errorForeground, border: colors.status.error, icon: 'error-warning', iconColor: colors.status.error };
    }
    if (state === 'waiting') {
      return { bg: colors.status.warning, fg: colors.status.warningForeground, border: colors.status.warning, icon: 'question', iconColor: colors.status.warning };
    }
    if (state === 'review') {
      return { bg: colors.status.info, fg: colors.status.infoForeground, border: colors.status.info, icon: 'eye', iconColor: colors.status.info };
    }
    // running — just activity, not an alert: neutral surface + spinner.
    return {
      bg: colors.surface.elevated,
      fg: colors.surface.foreground,
      border: colors.interactive.border,
      icon: 'loader-4',
      iconColor: colors.surface.mutedForeground,
      spin: true,
    };
  };

  const accent = accentFor(message.state);

  if (minimized) {
    return (
      <button
        type="button"
        data-pet-hit
        aria-label={t('pet.bubble.expandAria')}
        onClick={() => setMinimized(false)}
        className="pointer-events-auto flex items-center gap-1 rounded-full border px-2 py-1 shadow-lg"
        style={{
          backgroundColor: accent.bg,
          borderColor: accent.border,
          color: accent.fg,
          userSelect: 'none',
          cursor: 'pointer',
        }}
      >
        <Icon name={accent.icon} className={accent.spin ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        {message.count > 0 ? (
          <span className="text-[11px] font-semibold leading-none tabular-nums">{message.count}</span>
        ) : null}
      </button>
    );
  }

  const renderBody = () => {
    if (permission) {
      return (
        <div className="flex flex-col gap-1.5">
          <p
            className="truncate text-[11px]"
            style={{ color: currentTheme.colors.surface.mutedForeground }}
          >
            {permission.label}
          </p>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              onClick={(event) => {
                event.stopPropagation();
                onAction({ type: 'respond-permission', sessionId: permission.sessionId, id: permission.id, response: 'once' });
              }}
            >
              {t('pet.action.allow')}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                onAction({ type: 'respond-permission', sessionId: permission.sessionId, id: permission.id, response: 'reject' });
              }}
            >
              {t('pet.action.deny')}
            </Button>
          </div>
        </div>
      );
    }

    if (message.state === 'waiting') {
      return (
        <p className="text-[11px]" style={{ color: currentTheme.colors.surface.mutedForeground }}>
          {t('pet.bubble.waitingQuestion')}
        </p>
      );
    }

    if (message.state === 'review') {
      return (
        <p className="text-[11px]" style={{ color: currentTheme.colors.status.info }}>
          {t('pet.bubble.review')}
        </p>
      );
    }

    if (message.state === 'failed') {
      return (
        <p className="text-[11px]" style={{ color: currentTheme.colors.status.error }}>
          {t('pet.bubble.failed')}
        </p>
      );
    }

    // running
    const caption = thread?.caption?.trim();
    return (
      <p
        className="text-[11px] leading-snug"
        style={{
          color: currentTheme.colors.surface.mutedForeground,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {caption || t('pet.bubble.working')}
      </p>
    );
  };

  // The overlay window is focusable:false, so this card can never take keyboard
  // focus and onKeyDown won't fire in practice. role/tabIndex/onKeyDown are kept
  // only to satisfy jsx-a11y's click-events-have-key-events — the card can't be a
  // <button> because it wraps the minimize <button> below. onClick is the real path.
  return (
    <div
      role="button"
      tabIndex={0}
      data-pet-hit
      onClick={focusSession}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') focusSession();
      }}
      className="pointer-events-auto relative flex max-w-full flex-col gap-1 rounded-xl border py-2 pl-3 pr-7 text-left shadow-lg"
      style={{
        maxWidth: CARD_MAX_WIDTH,
        backgroundColor: currentTheme.colors.surface.elevated,
        borderColor: currentTheme.colors.interactive.border,
        userSelect: 'none',
        cursor: 'pointer',
      }}
    >
      <button
        type="button"
        aria-label={t('pet.bubble.minimizeAria')}
        onClick={(event) => {
          event.stopPropagation();
          setMinimized(true);
        }}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md hover:bg-[var(--interactive-hover)]"
        style={{ color: currentTheme.colors.surface.mutedForeground, cursor: 'pointer' }}
      >
        <Icon name="subtract" className="h-3.5 w-3.5" />
      </button>
      <div className="flex items-center gap-1.5">
        <Icon
          name={accent.icon}
          className={accent.spin ? 'h-3.5 w-3.5 shrink-0 animate-spin' : 'h-3.5 w-3.5 shrink-0'}
          style={{ color: accent.iconColor }}
        />
        <p
          className="truncate text-xs font-medium"
          style={{ color: currentTheme.colors.surface.foreground }}
        >
          {title}
        </p>
      </div>
      {renderBody()}
    </div>
  );
}
