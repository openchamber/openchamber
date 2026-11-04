import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { SelectionActionProps } from '../selectionModule';
import { useApproval } from './useApproval';

export function Desktop(props: SelectionActionProps) {
  const { approve, label } = useApproval(props, true);
  return (
    <Button type="button" variant="ghost" size="icon" onClick={approve} aria-label={label} title={label} className="rounded-full">
      <Icon name="thumb-up" className="size-4" />
    </Button>
  );
}
