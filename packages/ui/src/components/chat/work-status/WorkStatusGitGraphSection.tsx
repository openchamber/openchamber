import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/useUIStore';
import { useReportWorkStatusPresence } from './presenceContext';
import { WorkStatusCollapsibleSection } from './WorkStatusPrimitives';
import { GitGraphPanel } from '@/components/views/git/GitGraphPanel';
import {
  createGitCommitDetailsController,
  scheduleGitCommitDetailsIdle,
  type GitCommitDetailsController,
} from '@/components/views/git/gitCommitDetailsController';
import { selectGitCommitHoverRemote } from '@/components/views/git/gitCommitRemote';
import { createGitCommitHoverDetailsCache, preloadGitCommitHoverImage } from '@/components/views/git/gitCommitHoverCache';

type Props = {
  directory: string | null;
  panelVisible: boolean;
};

export const WorkStatusGitGraphSection: React.FC<Props> = ({ directory, panelVisible }) => {
  const { t } = useI18n();
  const { git, github } = useRuntimeAPIs();
  const openContextCommitDiff = useUIStore((state) => state.openContextCommitDiff);
  const storedExpanded = useUIStore((state) => state.workStatusExpandedSections.gitGraph);
  const expanded = storedExpanded ?? false;
  const [remotes, setRemotes] = React.useState<Array<{ name: string; fetchUrl: string; pushUrl: string }>>([]);

  const present = Boolean(directory && git);
  useReportWorkStatusPresence('gitGraph', present);

  const isActive = Boolean(directory && git && panelVisible && expanded);

  const controller = React.useMemo(() => {
    if (!directory || !git) {
      return null;
    }

    return createGitCommitDetailsController({
      directory,
      git,
      scheduleIdle: scheduleGitCommitDetailsIdle,
    });
  }, [directory, git]);

  React.useEffect(() => {
    return () => {
      controller?.dispose();
    };
  }, [controller]);

  React.useEffect(() => {
    if (!isActive || !directory || !git.getRemotes) {
      setRemotes([]);
      return;
    }

    let cancelled = false;
    void git.getRemotes(directory).then((nextRemotes) => {
      if (!cancelled) {
        setRemotes(nextRemotes);
      }
    }).catch(() => {
      if (!cancelled) {
        setRemotes([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [directory, git, isActive]);

  const hoverRemote = React.useMemo(() => selectGitCommitHoverRemote(remotes), [remotes]);
  const hoverDetailsCache = React.useMemo(() => {
    if (!isActive || !github?.commitDetails) {
      return null;
    }

    return createGitCommitHoverDetailsCache({
      load: ({ directory: nextDirectory, hash, remoteName }) => github.commitDetails!(nextDirectory, hash, remoteName ?? undefined),
      preloadImage: preloadGitCommitHoverImage,
    });
  }, [github, isActive]);

  React.useEffect(() => () => {
    hoverDetailsCache?.dispose();
  }, [hoverDetailsCache]);

  const handleCopyCommitHash = React.useCallback((hash: string) => {
    void copyTextToClipboard(hash).then((result) => {
      if (result.ok) {
        toast.success(t('gitView.toast.commitHashCopied'));
        return;
      }
      toast.error(t('gitView.toast.copyFailed'));
    });
  }, [t]);

  const commitDetailsController = React.useMemo<GitCommitDetailsController | null>(() => {
    if (!controller || !directory) {
      return null;
    }

    return {
      ...controller,
      selectFile(comparison, file) {
        openContextCommitDiff(directory, {
          commitHash: comparison.commitHash,
          parentHash: comparison.parentHash,
          file,
        });
      },
    };
  }, [controller, directory, openContextCommitDiff]);

  if (!directory || !git || !commitDetailsController) {
    return null;
  }

  return (
    <div id="work-status-git-graph" data-work-status-git-graph="true" className="min-h-0">
      <WorkStatusCollapsibleSection
        id="gitGraph"
        title={t('chat.workStatus.section.gitGraph')}
        icon="git-branch"
        defaultExpanded={false}
      >
        <div className="h-80 min-h-0 overflow-hidden">
          <GitGraphPanel
            directory={directory}
            git={git}
            isActive={isActive}
            readOnly={true}
            commitDetailsController={commitDetailsController}
            onCopyHash={handleCopyCommitHash}
            hoverRemoteName={hoverRemote?.name ?? null}
            hoverRemoteUrl={hoverRemote?.url ?? null}
            hoverDetailsCache={hoverDetailsCache}
          />
        </div>
      </WorkStatusCollapsibleSection>
    </div>
  );
};
