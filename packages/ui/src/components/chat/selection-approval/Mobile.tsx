import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { SelectionActionProps } from '../selectionModule';
import { useApproval } from './useApproval';

export function Mobile(props: SelectionActionProps) {
  const { approve, label } = useApproval(props, false);
  return (
    <Button type="button" variant="ghost" size="icon" onClick={approve} aria-label={label} title={label} className="h-11 w-11 shrink-0 rounded-xl bg-foreground/[0.04] active:opacity-80 transition-opacity duration-150">
      <Icon name="thumb-up" className="size-5" />
    </Button>
  );
}
