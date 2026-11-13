import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { readMergeMethod, rememberMergeMethod, type RememberedMergeMethod } from '@/components/views/git/mergeMethodPreference';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullRequestRef, PullStack, SourceControlCapabilities, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { newMutationKey } from '@/components/sourceBoard/mutationKey';

export function PullStackMerge({ context, stack, pull, onChanged }: {
  context: SourceControlReadContext; stack: PullStack; pull: GitHubPullRequestRef; onChanged: () => void;
}) {
  const { sourceControl } = useRuntimeAPIs();
  const { t } = useI18n();
  const confirmation = useConfirmDialog();
  const [busy, setBusy] = React.useState(false);
  const [chosen, setChosen] = React.useState<RememberedMergeMethod>(readMergeMethod);
  const [capabilities, setCapabilities] = React.useState<SourceControlCapabilities | null>(null);
  const bottom = stack.members.find((member) => member.state === 'open');
  React.useEffect(() => {
    let active = true;
    void sourceControl.capabilities(context).then((value) => { if (active) setCapabilities(value); }).catch(() => { if (active) setCapabilities(null); });
    return () => { active = false; };
  }, [context, sourceControl]);
  const methods = capabilities?.mergeChangeRequests
    ? (capabilities.mergeMethods ?? []).filter((method): method is RememberedMergeMethod => method !== 'submit') : [];
  const method = methods.includes(chosen) ? chosen : methods[0];
  const merge = async () => {
    if (!bottom || !method || busy) return;
    const runtime = getRuntimeKey();
    const approved = await confirmation.confirm({
      title: t('sourceBoard.merge.confirmTitle.pullRequest', { reference: `#${bottom.number}` }),
      message: t(`sourceBoard.merge.method.${method}`, { base: stack.trunk }), action: t('prStacks.mergeBottom', { number: bottom.number }),
    });
    if (!approved || getRuntimeKey() !== runtime) return;
    setBusy(true);
    try {
      const result = await sourceControl.githubPullStackMerge({ ...context, idempotencyKey: newMutationKey(),
        target: { project: { owner: pull.owner, name: pull.repo }, number: bottom.number, head: bottom.head, base: bottom.base, headSha: bottom.headSha },
      }, { ...pull, number: bottom.number, method });
      if (getRuntimeKey() !== runtime) return;
      const feedback = {
        merged: { show: toast.success, message: 'sourceBoard.toast.merged' },
        enqueued: { show: toast.info, message: 'prStacks.merge.enqueued' },
        pending: { show: toast.info, message: 'prStacks.merge.pending' },
      } as const;
      const { show, message } = feedback[result.status];
      show(t(message, { reference: `#${bottom.number}` }));
      onChanged();
    } catch (error) {
      if (getRuntimeKey() === runtime) toast.error(t('prStacks.actionFailed'), { description: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };
  if (!bottom || !method) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy || bottom.draft || bottom.summary === 'unknown'} onClick={() => void merge()}>
          <Icon name={busy ? 'loader-4' : 'git-merge'} className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {t('prStacks.mergeBottom', { number: bottom.number })}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={dropdownTriggerVariants()} disabled={busy} aria-label={t('sourceBoard.merge.methodAria')}>
              {t(`gitView.pr.mergeMethod.${method}`)}<Icon name="arrow-down-s" className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={method} onValueChange={(value) => {
              const next = methods.find((candidate) => candidate === value);
              if (next) { setChosen(next); rememberMergeMethod(next); }
            }}>
              {methods.map((value) => <DropdownMenuRadioItem key={value} value={value}>{t(`gitView.pr.mergeMethod.${value}`)}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {confirmation.dialog}
    </>
  );
}
