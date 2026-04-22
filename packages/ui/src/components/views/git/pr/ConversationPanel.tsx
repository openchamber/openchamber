import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiChat1Line, RiRobot2Line, RiLoader4Line } from '@remixicon/react';
import type { GitHubIssueComment, GitHubPullRequestReviewComment } from '@/lib/api/types';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';

interface ConversationPanelProps {
  issueComments?: GitHubIssueComment[];
  reviewComments?: GitHubPullRequestReviewComment[];
  onStartReviewSession?: (comment: GitHubPullRequestReviewComment, allComments: GitHubPullRequestReviewComment[]) => void;
  isStartingSession?: boolean;
  startingSessionId?: number | null;
}

const CommentRow: React.FC<{
  author?: { login?: string; avatarUrl?: string } | null;
  body: string;
  meta?: string;
  action?: React.ReactNode;
}> = ({ author, body, meta, action }) => (
  <div className="flex flex-col gap-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2.5">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {author?.avatarUrl ? (
          <img src={author.avatarUrl} alt={author.login} className="h-5 w-5 rounded-full" />
        ) : (
          <RiChat1Line className="size-4 text-[hsl(var(--muted-foreground))]" />
        )}
        <span className="typography-micro font-medium text-[hsl(var(--foreground))]">
          {author?.login || 'Unknown'}
        </span>
        {meta ? <span className="typography-micro text-[hsl(var(--muted-foreground))]">{meta}</span> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
    {body?.trim() ? (
      <SimpleMarkdownRenderer
        content={body}
        className="typography-markdown-body text-[hsl(var(--foreground))] break-words"
      />
    ) : (
      <span className="typography-micro italic text-[hsl(var(--muted-foreground))]">No comment body.</span>
    )}
  </div>
);

export const ConversationPanel: React.FC<ConversationPanelProps> = ({
  issueComments,
  reviewComments,
  onStartReviewSession,
  isStartingSession,
  startingSessionId,
}) => {
  const total = (issueComments?.length ?? 0) + (reviewComments?.length ?? 0);

  if (total === 0) {
    return (
      <div className="typography-micro text-[hsl(var(--muted-foreground))]">
        No comments yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h4 className="typography-ui-label font-medium text-[hsl(var(--foreground))]">
        Conversation ({total})
      </h4>
      <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-1">
        {issueComments?.map((comment) => (
          <CommentRow
            key={`issue-${comment.id}`}
            author={comment.author}
            body={comment.body}
          />
        ))}
        {reviewComments?.map((comment) => {
          const action = onStartReviewSession ? (
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                  onClick={() => onStartReviewSession(comment, reviewComments)}
                  disabled={isStartingSession}
                  aria-label="Start session with this comment"
                >
                  {isStartingSession && startingSessionId === comment.id ? (
                    <RiLoader4Line className="size-3.5 animate-spin" />
                  ) : (
                    <RiRobot2Line className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left"><p>Start session with this comment</p></TooltipContent>
            </Tooltip>
          ) : undefined;

          return (
            <CommentRow
              key={`review-${comment.id}`}
              author={comment.author}
              body={comment.body}
              meta={comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : undefined}
              action={action}
            />
          );
        })}
      </div>
    </div>
  );
};
