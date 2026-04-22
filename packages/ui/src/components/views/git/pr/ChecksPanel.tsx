import React from 'react';
import { RiExternalLinkLine, RiErrorWarningLine, RiCheckLine, RiLoader4Line, RiQuestionLine } from '@remixicon/react';
import type { GitHubCheckRun } from '@/lib/api/types';
import { openExternalUrl } from '@/lib/url';

interface ChecksPanelProps {
  checkRuns?: GitHubCheckRun[];
  onFixWithAI?: () => void;
}

const statusIcon = (status?: string, conclusion?: string | null) => {
  if (status === 'queued' || status === 'in_progress') {
    return <RiLoader4Line className="size-4 animate-spin text-[hsl(var(--status-warning))]" />;
  }
  const c = (conclusion || '').toLowerCase();
  if (c === 'success' || c === 'neutral' || c === 'skipped') {
    return <RiCheckLine className="size-4 text-[hsl(var(--status-success))]" />;
  }
  if (c === 'failure' || c === 'timed_out' || c === 'cancelled') {
    return <RiErrorWarningLine className="size-4 text-[hsl(var(--status-error))]" />;
  }
  return <RiQuestionLine className="size-4 text-[hsl(var(--status-warning))]" />;
};

export const ChecksPanel: React.FC<ChecksPanelProps> = ({ checkRuns, onFixWithAI }) => {
  if (!checkRuns || checkRuns.length === 0) {
    return (
      <div className="typography-micro text-[hsl(var(--muted-foreground))]">
        No checks available.
      </div>
    );
  }

  const hasFailures = checkRuns.some((r) => {
    const c = (r.conclusion || '').toLowerCase();
    return c === 'failure' || c === 'timed_out' || c === 'cancelled';
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h4 className="typography-ui-label font-medium text-[hsl(var(--foreground))]">Checks</h4>
        {hasFailures && onFixWithAI ? (
          <button
            type="button"
            onClick={onFixWithAI}
            className="typography-micro text-[hsl(var(--status-error))] hover:underline"
          >
            Fix with AI
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        {checkRuns.map((run) => (
          <div
            key={run.id ?? run.name}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[hsl(var(--accent))]"
          >
            {statusIcon(run.status, run.conclusion)}
            <span className="typography-micro flex-1 truncate text-[hsl(var(--foreground))]">
              {run.name}
            </span>
            {run.detailsUrl ? (
              <button
                type="button"
                onClick={() => {
                  if (run.detailsUrl) {
                    openExternalUrl(run.detailsUrl);
                  }
                }}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                aria-label="Open check details"
              >
                <RiExternalLinkLine className="size-3.5" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};
