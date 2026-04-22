import React from 'react';
import { RiUserLine, RiTeamLine } from '@remixicon/react';
import type { GitHubPullRequestReview, GitHubRequestedReviewers, GitHubUserSummary } from '@/lib/api/types';

interface ReviewersPanelProps {
  reviews?: GitHubPullRequestReview[];
  requestedReviewers?: GitHubRequestedReviewers;
}

const approvalDot = (state: string) => {
  const s = state.toLowerCase();
  if (s === 'approved') return <span className="h-2 w-2 rounded-full bg-[hsl(var(--status-success))]" />;
  if (s === 'changes_requested') return <span className="h-2 w-2 rounded-full bg-[hsl(var(--status-error))]" />;
  if (s === 'commented') return <span className="h-2 w-2 rounded-full bg-[hsl(var(--status-info))]" />;
  return <span className="h-2 w-2 rounded-full bg-[hsl(var(--muted-foreground))]" />;
};

const Avatar: React.FC<{ user?: GitHubUserSummary | null }> = ({ user }) => {
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt={user.login} className="h-5 w-5 rounded-full" />;
  }
  return <RiUserLine className="size-4 text-[hsl(var(--muted-foreground))]" />;
};

export const ReviewersPanel: React.FC<ReviewersPanelProps> = ({ reviews, requestedReviewers }) => {
  const hasData = (reviews && reviews.length > 0) || (requestedReviewers && (requestedReviewers.users.length > 0 || requestedReviewers.teams.length > 0));

  if (!hasData) {
    return (
      <div className="typography-micro text-[hsl(var(--muted-foreground))]">
        No reviewers assigned.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h4 className="typography-ui-label font-medium text-[hsl(var(--foreground))]">Reviewers</h4>

      {requestedReviewers && (requestedReviewers.users.length > 0 || requestedReviewers.teams.length > 0) ? (
        <div className="flex flex-col gap-1">
          <span className="typography-micro text-[hsl(var(--muted-foreground))]">Requested</span>
          <div className="flex flex-wrap gap-2">
            {requestedReviewers.users.map((u) => (
              <div key={u.id} className="flex items-center gap-1 rounded-full bg-[hsl(var(--accent))] px-2 py-0.5">
                <Avatar user={u} />
                <span className="typography-micro text-[hsl(var(--foreground))]">{u.login}</span>
              </div>
            ))}
            {requestedReviewers.teams.map((t) => (
              <div key={t.slug} className="flex items-center gap-1 rounded-full bg-[hsl(var(--accent))] px-2 py-0.5">
                <RiTeamLine className="size-3.5 text-[hsl(var(--muted-foreground))]" />
                <span className="typography-micro text-[hsl(var(--foreground))]">{t.name || t.slug}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {reviews && reviews.length > 0 ? (
        <div className="flex flex-col gap-1">
          {reviews.map((review) => (
            <div key={review.id} className="flex items-center gap-2 rounded-md px-2 py-1">
              {approvalDot(review.state)}
              <Avatar user={review.author} />
              <span className="typography-micro flex-1 text-[hsl(var(--foreground))]">
                {review.author?.login || 'Unknown'}
              </span>
              <span className="typography-micro text-[hsl(var(--muted-foreground))]">
                {review.state.replace(/_/g, ' ')}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
