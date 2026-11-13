import { toast } from '@/components/ui';
import { useFireworksCelebration } from '@/contexts/FireworksContext';
import { useEasterEggCopy } from '@/lib/easter-eggs/easterEggCopy';
import { netDeletionLine, pushLine } from '@/lib/easter-eggs/lines';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';

const seed = () => Math.floor(Math.random() * 1000);

/**
 * The toasts and confetti of a commit and its push, shared by the desktop Git
 * panel and the phone's Changes surface so both celebrate the same way.
 */
export function useCommitCelebration() {
  const { t } = useI18n();
  const { triggerFireworks } = useFireworksCelebration();
  const copy = useEasterEggCopy();

  /** Toasts a new commit. Returns whether it was a net deletion, which its push celebrates in red. */
  const committed = (
    summary: { insertions: number; deletions: number },
    { pushAfter, origin }: { pushAfter?: boolean; origin?: HTMLElement },
  ): boolean => {
    const line = copy ? netDeletionLine(copy, summary, getCurrentIntlLocale(), seed()) : null;
    if (line) toast.success(line.title, { description: line.description });
    else toast.success(t('gitView.toast.commitCreated'));
    // A commit-only deletion celebrates now; with a push it waits for the push.
    if (line && !pushAfter) triggerFireworks({ kind: 'deletion', origin });
    return line !== null;
  };

  const pushed = ({ deletion, origin }: { deletion: boolean; origin?: HTMLElement }) => {
    const line = copy ? pushLine(copy, new Date(), getCurrentIntlLocale(), seed()) : null;
    if (line) toast.success(line.title, { description: line.description });
    else toast.success(t('gitView.publish.succeeded'));
    triggerFireworks({ kind: deletion ? 'deletion' : 'push', origin });
  };

  return { committed, pushed };
}
