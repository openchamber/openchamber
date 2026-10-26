import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { cn } from '@/lib/utils';

/**
 * Said in place of a change request's diff (Changes, Walkthrough, mobile
 * Changes) when its host lists change requests but does not serve their diff.
 * Nothing failed, so there is nothing to retry.
 */
export function ChangeRequestDiffUnavailable({ provider, className }: { provider: string | null; className?: string }) {
  const { t } = useI18n();
  const descriptor = useSourceControlProvider(provider);
  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center', className)}>
      <Icon name="git-pull-request" className="size-6 text-muted-foreground" />
      <p className="max-w-sm typography-meta text-muted-foreground">
        {t(changeRequestCopy('pullRequestComparison.diffUnavailable', descriptor.terminology.changeRequest), { provider: descriptor.label })}
      </p>
    </div>
  );
}
