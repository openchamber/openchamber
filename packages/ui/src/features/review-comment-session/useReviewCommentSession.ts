import { useState, useCallback } from 'react';
import { createWorktreeSessionForBranch } from '@/lib/worktreeSessionCreator';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useConfigStore } from '@/stores/useConfigStore';
import type { GitHubPullRequestSummary, GitHubPullRequestReviewComment } from '@/lib/api/types';

export function useReviewCommentSession() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);

  const startSession = useCallback(
    async (
      pr: GitHubPullRequestSummary,
      comment: GitHubPullRequestReviewComment,
      allReviewComments: GitHubPullRequestReviewComment[]
    ) => {
      setLoading(true);
      setError(null);
      try {
        if (!pr.head) {
          throw new Error('Pull request head branch is unknown');
        }

        // Build thread
        const threadId = comment.inReplyToId || comment.id;
        const threadComments = allReviewComments
          .filter((c) => c.id === threadId || c.inReplyToId === threadId)
          .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

        const diffHunk = comment.diffHunk || threadComments[0]?.diffHunk || '';
        const path = comment.path || threadComments[0]?.path || 'unknown';
        const line = comment.line || threadComments[0]?.line;
        
        let seed = `The reviewer is asking for the change above. Propose a minimal diff.\n\n`;
        seed += `File: \`${path}\`${line ? ` at line ${line}` : ''}\n\n`;
        
        if (diffHunk) {
          seed += `\`\`\`diff\n${diffHunk}\n\`\`\`\n\n`;
        } else {
          seed += `*(No diff hunk available for this comment - it may be outdated)*\n\n`;
        }

        seed += `### Review Thread:\n\n`;
        for (const c of threadComments) {
          seed += `**@${c.author?.login || 'Reviewer'}**: ${c.body}\n\n`;
        }

        const session = await createWorktreeSessionForBranch(currentDirectory, pr.head, {
          kind: 'pr',
          worktreeName: pr.head,
          existingBranch: pr.head,
          ensureRemoteName: pr.headRepo?.owner,
          ensureRemoteUrl: pr.headRepo?.cloneUrl,
        });

        if (session && seed) {
          const configState = useConfigStore.getState();
          const model = configState.settingsDefaultModel;
          if (!model) {
            throw new Error('No default model configured');
          }
          const [providerID, modelID] = model.split('/');
          if (!providerID || !modelID) {
            throw new Error('Invalid default model format');
          }
          const { opencodeClient } = await import('@/lib/opencode/client');
          await opencodeClient.sendMessage({
            id: session.id,
            providerID,
            modelID,
            text: seed,
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start review session');
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [currentDirectory]
  );

  return { startSession, loading, error };
}
