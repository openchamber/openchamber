import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

/**
 * The space mark for the "hide whitespace changes" toggle, struck through
 * while those changes are hidden, so the icon says which state is on.
 */
export const WhitespaceToggleIcon = ({ hidden, className }: { hidden: boolean; className?: string }) => (
  <span className={cn('relative inline-flex', className)} aria-hidden="true">
    <Icon name="space" className="size-full" />
    {hidden ? (
      <span className="absolute left-1/2 top-1/2 h-[1.5px] w-[130%] -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-current" />
    ) : null}
  </span>
);
