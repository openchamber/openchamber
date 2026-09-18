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

export function useGitPublishChooser({ directory, branch, chooseContributor }: {
  directory: string | null | undefined;
  branch: string | undefined;
  chooseContributor: (candidates: ContributorDestinationCandidate[]) => Promise<string | null>;
}) {
  const { git, sourceControl, runtime } = useRuntimeAPIs();
  const { t } = useI18n();
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
    const confirmSystemTransport = () => window.confirm(t('gitView.confirm.systemTransport'));
    if (provenance.kind === 'contributor') {
      const status = await git.getGitStatus(directory);
      assertCurrent();
      if (!status.current || status.current === 'HEAD') throw new BoundGitNetworkOperationError('branch-required');
      if (options.beforeCommit && !window.confirm(t('gitView.publish.contributorCommitFirst'))) {
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
          const remote = binding.binding?.remotes.find((entry) => current.tracking?.startsWith(`${entry.name}/`));
          await runContributorAwareSync({
            directory, remoteName: remote?.name ?? '', status: current, git, sourceControl,
            choose: chooseContributor, confirmSystemTransport, onOperation: options.onOperation,
          });
        } else {
          await runContributorAwarePush({
            directory, branch: current.current, remoteName: '', git, sourceControl,
            choose: chooseContributor, confirmSystemTransport, onOperation: options.onOperation,
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
      await runPreparedGitPublish({ selection, git, sourceControl, confirmSystemTransport, allowNewCommit: options.beforeCommit, assertCurrent, onOperation: options.onOperation });
      assertCurrent();
      // A failed post-push read cannot undo a completed publication or retain reusable authority.
      const current = await readGitPublishContext({ action, directory, git, sourceControl }).catch(() => null);
      assertCurrent();
      const previousBinding = selection.bindingRead.binding;
      if (current && current.status.current === selection.status.current
        && current.bindingRead.binding.repositoryId === previousBinding.repositoryId
        && current.bindingRead.binding.revision === previousBinding.revision
        && current.bindingRead.binding.configRevision === previousBinding.configRevision
        && JSON.stringify(current.bindingRead.binding.remotes) === JSON.stringify(previousBinding.remotes)
        && (current.status.tracking === selection.status.tracking
          || (!selection.status.tracking && current.status.tracking === `${selection.targets.push.remoteName}/${selection.targets.push.ref.slice(11)}`))) {
        confirmed.current = { ...current, targets: selection.targets };
      }
    };
  };

  const errorMessage = (error: BoundGitNetworkOperationError) => {
    // No usable transport grant: point at the configuration instead of a bare "failed".
    if (error.code === 'binding-required' || error.code === 'binding-needs-attention') return t('gitView.publish.noGrants');
    if (error.code === 'anonymous-read-only') return t('settings.sourceControl.transport.anonymous');
    if (error.code === 'branch-required') return t('gitView.publish.detached');
    if (error.code === 'publish-selection-stale') return t('gitView.publish.stale');
    if (error.code === 'publish-cancelled') return t('gitView.publish.cancelled');
    return null;
  };

  return { context, settle, prepare, errorMessage };
}
