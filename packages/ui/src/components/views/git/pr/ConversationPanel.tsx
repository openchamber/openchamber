import React from 'react';
import { RiChat1Line } from '@remixicon/react';
import type { GitHubIssueComment, GitHubPullRequestReviewComment } from '@/lib/api/types';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';

interface ConversationPanelProps {
  issueComments?: GitHubIssueComment[];
  reviewComments?: GitHubPullRequestReviewComment[];
}

const CommentRow: React.FC<{
  author?: { login?: string; avatarUrl?: string } | null;
  body: string;
  meta?: string;
}> = ({ author, body, meta }) => (
  <div className="flex flex-col gap-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2.5">
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

export const ConversationPanel: React.FC<ConversationPanelProps> = ({ issueComments, reviewComments }) => {
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
        {reviewComments?.map((comment) => (
          <CommentRow
            key={`review-${comment.id}`}
            author={comment.author}
            body={comment.body}
            meta={comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : undefined}
          />
        ))}
      </div>
    </div>
  );
};
