import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { usePullAttachments } from '@/components/sourceBoard/pullAttachments';
import { newMutationKey } from '@/components/sourceBoard/mutationKey';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryChangeRequestReference, PullRequestStack, PullRequestStackLayer, PullStack, SourceControlReadContext } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { supportsGitHubAutomation } from '@/lib/source-control/githubAutomation';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { cn } from '@/lib/utils';
import { useRepositoryReadContext } from './referenceSources';
import { REFERENCE_META_TEXT, referenceNumberLabel, repositoryStateLook } from './referencePickerItems';
import { PullStackMemberRow } from './PullStackMemberRow';
import { PullStackMerge } from './PullStackMerge';
import { PullStackRestack } from './PullStackRestack';
import { PullStackRows } from './PullStackRows';
import { usePullStack } from './usePullStack';

const loadCreateDialog = () => import('@/components/views/git/StackedPullCreateDialog').then((module) => module.StackedPullCreateDialog);
type Props = {
  readonly reference: RepositoryChangeRequestReference;
  readonly directory: string | null;
  readonly nativeStack: PullRequestStack | null;
  readonly currentLook: ReturnType<typeof repositoryStateLook>;
  readonly enabled?: boolean;
  readonly onOpenLayer?: (layer: PullRequestStackLayer) => void;
  readonly onChanged?: () => void | Promise<void>;
};

/** Native membership is the map; the fork adds local recovery and whole-stack actions to it. */
export function PullStackSection(props: Props) {
  const bound = useRepositoryReadContext(props.enabled === false || isVSCodeRuntime() ? null : props.directory);
  if (props.enabled === false || !bound || bound === 'missing' || !supportsGitHubAutomation(bound) || bound.provider !== props.reference.provider) {
    return props.nativeStack ? <StackMap {...props} stack={props.nativeStack} /> : null;
  }
  return <StackContents key={JSON.stringify([getRuntimeKey(), bound, props.reference.sourceRepo, props.reference.number])} {...props} context={bound} />;
}

function StackMap({ reference, stack, currentLook, onOpenLayer, enriched, renderDetails, children }: Props & {
  readonly stack: PullRequestStack;
  readonly enriched?: PullStack | null;
  readonly renderDetails?: (layer: PullRequestStackLayer) => React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const descriptor = useSourceControlProvider(reference.provider);
  const position = stack.layers.findIndex((layer) => layer.number === reference.number) + 1;
  return <section className="flex min-w-0 flex-col gap-2 border-b border-border/60 pb-4">
    <h4 className="flex items-center gap-2 typography-ui-label font-semibold text-foreground">
      {t('stacks.preview.label')}
      {position > 0 ? <span className={cn('typography-meta font-normal tabular-nums', REFERENCE_META_TEXT)}>
        {t('stacks.preview.position', { position, size: stack.layers.length })}
      </span> : null}
      {enriched ? <span className={cn('typography-meta font-normal', REFERENCE_META_TEXT)}>{t(enriched.source === 'native' ? 'prStacks.native' : 'prStacks.inferred')}</span> : null}
      {stack.number !== null && stack.layers.filter((layer) => layer.state === 'open').length > 1 ? (
        <a href={reference.url} target="_blank" rel="noopener noreferrer" className={cn('ms-auto inline-flex items-center gap-1 typography-meta font-normal hover:text-foreground', REFERENCE_META_TEXT)}>
          {t('stacks.preview.rebaseOnHost')}<Icon name="external-link" className="size-3.5" />
        </a>
      ) : null}
    </h4>
    <PullStackRows stack={stack} current={reference.number} numberLabel={(number) => referenceNumberLabel({ ...reference, number }, descriptor)}
      currentLook={currentLook} onOpen={onOpenLayer} renderDetails={renderDetails} />
    {children}
  </section>;
}

function StackContents(props: Props & { readonly context: SourceControlReadContext }) {
  const { reference, context, onOpenLayer, onChanged } = props;
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const pull = React.useMemo(() => ({ ...reference.sourceRepo, number: reference.number }), [reference.number, reference.sourceRepo]);
  const state = usePullStack(context, pull);
  const { refresh: refreshStack } = state;
  const openTrackerItem = useOpenTrackerItem();
  const attachments = usePullAttachments(reference);
  const [busy, setBusy] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const CreateDialog = useOnDemandComponent(createOpen, loadCreateDialog, () => { setCreateOpen(false); toast.error(t('prStacks.actionFailed')); });
  const refresh = React.useCallback(() => {
    if (onChanged) void Promise.resolve(onChanged()).then(refreshStack, refreshStack);
    else refreshStack();
  }, [onChanged, refreshStack]);
  const retarget = async (member: PullStack['members'][number]) => {
    if (!member.retargetTo || busy) return;
    const runtime = getRuntimeKey();
    setBusy(true);
    try {
      await sourceControl.githubPullStackRetarget({ ...context, idempotencyKey: newMutationKey(),
        target: { project: { owner: pull.owner, name: pull.repo }, number: member.number, head: member.head, base: member.base, headSha: member.headSha },
      }, { ...pull, number: member.number, base: member.retargetTo });
      if (getRuntimeKey() === runtime) refresh();
    } catch (error) {
      if (getRuntimeKey() === runtime) toast.error(t('prStacks.actionFailed'), { description: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };
  const stack = state.stack;
  const map = props.nativeStack ?? (stack ? { number: stack.nativeNumber, base: stack.trunk, layers: stack.members } : null);
  const error = state.error ? <div role="alert" className="flex flex-wrap items-center gap-2 typography-meta text-[var(--status-error-text)]">
    <span>{t('references.picker.error.load', { error: state.error })}</span>
    <Button size="sm" variant="outline" onClick={refresh}>{t('references.picker.actions.retry')}</Button>
  </div> : null;
  if (!map) return error;
  return <StackMap {...props} stack={map} enriched={stack}
    onOpenLayer={onOpenLayer ?? ((layer) => openTrackerItem(layer.url, context.directory))}
    renderDetails={(layer) => {
      const member = stack?.members.find((member) => member.number === layer.number);
      return member ? <PullStackMemberRow member={member} reference={reference} busy={busy || state.status !== 'ready'} onRetarget={() => void retarget(member)} /> : null;
    }}>
    {error}
    {stack ? <>
      {stack.nativeUnavailable ? <p className="typography-meta text-muted-foreground">{t('prStacks.nativeUnavailable')}</p> : null}
      {stack.branches.length ? <p className="break-words typography-meta text-muted-foreground">{t('prStacks.extraBranches', { branches: stack.branches.map((branch) => `#${branch.number} ${branch.title}`).join(', ') })}</p> : null}
      <PullStackRestack context={context} stack={stack} pull={pull} onChanged={refresh} enabled={state.status === 'ready'} />
      {state.status === 'ready' ? <div className="flex flex-wrap items-center gap-2">
        <PullStackMerge context={context} stack={stack} pull={pull} onChanged={refresh} />
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)} disabled={!stack.members.some((member) => member.state === 'open')}>
          <Icon name="git-pull-request" className="size-3.5" />{t('prStacks.onTop')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => {
          setBusy(true);
          void attachments.attachStack(stack, context).finally(() => setBusy(false));
        }}><Icon name="attachment-2" className="size-3.5" />{t('prStacks.attach')}</Button>
      </div> : null}
      {CreateDialog && createOpen ? <CreateDialog directory={context.directory} stack={stack} onClose={() => setCreateOpen(false)} /> : null}
    </> : null}
  </StackMap>;
}
