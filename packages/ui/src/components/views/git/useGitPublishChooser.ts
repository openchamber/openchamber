import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import {
  BoundGitNetworkOperationError, prepareGitPublish, readGitPublishContext,
  runContributorAwarePush, runContributorAwareSync, runPreparedGitPublish,
  validateGitPublishSelection,
  type GitPublishContext, type GitPublishSelection, type GitPublishTargets,
} from '@/lib/boundGitNetworkOperation';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { ContributorDestinationCandidate } from './contributorDestination';
import { effectiveRepositoryBinding } from '@/lib/source-control/types';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';

const obviousPublishTargets = (context: GitPublishContext): GitPublishTargets | null => {
  const remotes = effectiveRepositoryBinding(context.bindingRead).remotes
    .filter((remote) => remote.readiness === 'ready' && remote.mode !== 'anonymous');
  const branch = context.status.current;
  const tracking = context.status.tracking ?? '';
  const tracked = remotes.find((remote) => tracking.startsWith(`${remote.name}/`));
  if (tracked) {
    const ref = `refs/heads/${tracking.slice(tracked.name.length + 1)}`;
    return context.action === 'sync'
      ? { push: { remoteName: tracked.name, ref }, fetch: { remoteName: tracked.name, ref } }
      : { push: { remoteName: tracked.name, ref } };
  }
  if (context.action !== 'push') return null;
  // A new branch goes where the repository's identity points: the remote its
  // account answers for, or the one remote it holds a grant of its own for.
  // Remotes reached through that identity are fetchable forks, not where a
  // branch is published unless someone picks them.
  const binding = effectiveRepositoryBinding(context.bindingRead);
  const own = remotes.filter((remote) => !remote.inherited);
  const home = remotes.find((remote) => remote.name === binding.providers[0]?.primaryRemote)
    ?? (own.length === 1 ? own[0] : null)
    ?? (remotes.length === 1 ? remotes[0] : null);
  return home ? { push: { remoteName: home.name, ref: `refs/heads/${branch}` } } : null;
};

export function useGitPublishChooser({ directory, branch, chooseContributor }: {
  directory: string | null | undefined;
  branch: string | undefined;
  chooseContributor: (candidates: ContributorDestinationCandidate[]) => Promise<string | null>;
}) {
  const { git, sourceControl, runtime } = useRuntimeAPIs();
  const { t } = useI18n();
  const confirmation = useConfirmDialog();
  const [context, setContext] = React.useState<GitPublishContext | null>(null);
  const pending = React.useRef<((targets: GitPublishTargets | null) => void) | null>(null);
  const confirmed = React.useRef<GitPublishSelection | null>(null);
  const generation = React.useRef(0);

  const settle = (targets: GitPublishTargets | null) => {
    const resolve = pending.current;
    pending.current = null;
    setContext(null);
    resolve?.(targets);
  };

  React.useEffect(() => {
    const cancel = () => {
      generation.current += 1;
      confirmed.current = null;
      const resolve = pending.current;
      pending.current = null;
      setContext(null);
      resolve?.(null);
    };
    const unsubscribe = subscribeRuntimeEndpointWillChange(cancel);
    return () => { unsubscribe(); cancel(); };
  }, [directory, branch]);

  const prepare = async (action: 'push' | 'sync', options: { beforeCommit?: boolean; forceChoose?: boolean; onOperation?: Parameters<typeof runPreparedGitPublish>[0]['onOperation'] } = {}) => {
    if (!directory) throw new BoundGitNetworkOperationError('binding-required');
    const capturedRuntime = getRuntimeKey();
    const capturedGeneration = generation.current;
    const assertCurrent = () => {
      if (getRuntimeKey() !== capturedRuntime) throw new BoundGitNetworkOperationError('stale-runtime');
      if (generation.current !== capturedGeneration) throw new BoundGitNetworkOperationError('publish-selection-stale');
    };
    const provenance = runtime.isVSCode ? { kind: 'ordinary' as const } : await git.listContributorDestinations(directory);
    assertCurrent();
    if (provenance.kind === 'contributor') {
      const status = await git.getGitStatus(directory);
      assertCurrent();
      if (!status.current || status.current === 'HEAD') throw new BoundGitNetworkOperationError('branch-required');
      if (options.beforeCommit && !await confirmation.confirm({
        title: t('gitView.publish.contributorCommitFirstTitle'),
        message: t('gitView.publish.contributorCommitFirst'),
        action: t('gitView.publish.contributorCommitFirstAction'),
      })) {
        throw new BoundGitNetworkOperationError('publish-cancelled');
      }
      return async () => {
        assertCurrent();
        const current = await git.getGitStatus(directory);
        assertCurrent();
        if (current.current !== status.current) throw new BoundGitNetworkOperationError('publish-selection-stale');
        if (action === 'sync') {
          const binding = await sourceControl.repositoryBinding(directory);
          assertCurrent();
          const remote = effectiveRepositoryBinding(binding).remotes.find((entry) => current.tracking?.startsWith(`${entry.name}/`));
          await runContributorAwareSync({
            directory, remoteName: remote?.name ?? '', status: current, git, sourceControl,
            choose: chooseContributor, onOperation: options.onOperation,
          });
        } else {
          await runContributorAwarePush({
            directory, branch: current.current, remoteName: '', git, sourceControl,
            choose: chooseContributor, onOperation: options.onOperation,
          });
        }
      };
    }

    let selection: GitPublishSelection;
    const previous = confirmed.current;
    if (!options.forceChoose && previous && (action === 'push' || previous.targets.fetch)) {
      // Only a target confirmed in this mounted panel can skip the chooser. Tracking is not push authority.
      confirmed.current = null;
      const current = await validateGitPublishSelection({ selection: previous, git, sourceControl, allowNewCommit: true });
      selection = { ...current, action, targets: previous.targets };
    } else {
      selection = await prepareGitPublish({
        action, directory, git, sourceControl,
        choose: (next) => {
          assertCurrent();
          // One clear answer needs no dialog: the branch's own remote, or the
          // only remote there is. The dialog is for the genuinely open case.
          const obvious = options.forceChoose ? null : obviousPublishTargets(next);
          if (obvious) return Promise.resolve(obvious);
          return new Promise<GitPublishTargets | null>((resolve) => {
            pending.current?.(null);
            pending.current = resolve;
            setContext(next);
          });
        },
      });
    }
    assertCurrent();
    confirmed.current = selection;
    return async () => {
      assertCurrent();
      confirmed.current = null;
      await runPreparedGitPublish({ selection, git, sourceControl, allowNewCommit: options.beforeCommit, assertCurrent, onOperation: options.onOperation });
      assertCurrent();
      // A failed post-push read cannot undo a completed publication or retain reusable authority.
      const current = await readGitPublishContext({ action, directory, git, sourceControl }).catch(() => null);
      assertCurrent();
      const previousBinding = effectiveRepositoryBinding(selection.bindingRead);
      const currentBinding = current ? effectiveRepositoryBinding(current.bindingRead) : null;
      if (current && currentBinding && current.status.current === selection.status.current
        && currentBinding.repositoryId === previousBinding.repositoryId
        && currentBinding.revision === previousBinding.revision
        && currentBinding.configRevision === previousBinding.configRevision
        && JSON.stringify(currentBinding.remotes) === JSON.stringify(previousBinding.remotes)
        && (current.status.tracking === selection.status.tracking
          || (!selection.status.tracking && current.status.tracking === `${selection.targets.push.remoteName}/${selection.targets.push.ref.slice(11)}`))) {
        confirmed.current = { ...current, targets: selection.targets };
      }
    };
  };

  const errorMessage = (error: BoundGitNetworkOperationError) => {
    // Nothing to transfer with: say what is missing instead of a bare "failed".
    if (error.code === 'binding-required') return t('gitView.publish.noGrants');
    if (error.code === 'binding-needs-attention') return t('gitView.publish.needsAttention');
    if (error.code === 'binding-remote-missing') return t('gitView.publish.remoteNotGranted');
    if (error.code === 'tracking-required') return t('gitView.publish.trackingRequired');
    if (error.code === 'tracking-remote-mismatch') return t('gitView.publish.trackingRemoteMismatch');
    if (error.code === 'anonymous-read-only') return t('settings.sourceControl.transport.anonymous');
    if (error.code === 'branch-required') return t('gitView.publish.detached');
    if (error.code === 'publish-selection-stale') return t('gitView.publish.stale');
    if (error.code === 'publish-cancelled') return t('gitView.publish.cancelled');
    return null;
  };

  return { context, settle, prepare, errorMessage, confirmDialog: confirmation.dialog };
}
