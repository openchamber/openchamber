import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useLeaderKeyStore } from '@/stores/useLeaderKeyStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { Kbd, ShortcutKbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';

const LEADER_ACTIONS = [
  { key: 'M', labelKey: 'chat.leaderKey.action.model' as const },
  { key: 'A', labelKey: 'chat.leaderKey.action.agent' as const },
  { key: 'N', labelKey: 'chat.leaderKey.action.newSession' as const },
  { key: 'C', labelKey: 'chat.leaderKey.action.compact' as const },
] as const;

/**
 * Subtle pending-state chrome for the Ctrl+X leader chord.
 * Renders above the composer while waiting for M / A / N / C.
 */
export const LeaderKeyHint: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const pending = useLeaderKeyStore((state) => state.pending);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const leaderLabel = formatShortcutForDisplay(
    getEffectiveShortcutCombo('leader_key', shortcutOverrides) || 'ctrl+x',
  );

  if (!pending) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('chat.leaderKey.pendingAria')}
      className={cn(
        'pointer-events-none absolute left-1/2 top-0 z-20 -translate-x-1/2 -translate-y-[calc(100%+0.4rem)]',
        'inline-flex max-w-[calc(100cqw-1rem)] items-center gap-2 overflow-x-auto rounded-lg border px-2.5 py-1.5',
        'border-[var(--interactive-border)] bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)]',
        'shadow-sm animate-in fade-in-0 zoom-in-95 duration-150 whitespace-nowrap',
        className,
      )}
    >
      <ShortcutKbd shortcut={leaderLabel} />
      <span className="typography-micro text-[var(--surface-muted-foreground)]">·</span>
      {LEADER_ACTIONS.map((action, index) => (
        <React.Fragment key={action.key}>
          {index > 0 ? (
            <span className="typography-micro text-[var(--surface-muted-foreground)]">·</span>
          ) : null}
          <span className="inline-flex items-center gap-1 typography-micro">
            <Kbd className="border-[var(--interactive-selection)] bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]">
              {action.key}
            </Kbd>
            <span className="text-[var(--surface-muted-foreground)]">{t(action.labelKey)}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
};
