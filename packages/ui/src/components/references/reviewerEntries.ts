import type {
  RepositoryReferenceDetail,
  RepositoryReferenceReview,
  RepositoryReferenceReviewer,
} from '@/lib/api/types';
import type { ReviewerStateValue } from '@/lib/source-control/types';

export type ReviewerEntry = {
  key: string;
  person: RepositoryReferenceReviewer;
  state?: ReviewerStateValue;
  reviews: RepositoryReferenceReview[];
};

type PullReviews = NonNullable<RepositoryReferenceDetail['pull']>;

const STATE_ORDER = {
  changes_requested: 0,
  approved: 1,
  commented: 2,
  pending: 3,
  dismissed: 4,
} satisfies Record<ReviewerStateValue, number>;

export const mergeReviewerEntries = (pull: PullReviews): ReviewerEntry[] => {
  const states = pull.reviewerStates;
  const reviews = pull.reviews ?? [];
  const entries = new Map<string, ReviewerEntry>();
  const entryFor = (person: RepositoryReferenceReviewer): ReviewerEntry => {
    const known = entries.get(person.login);
    if (known) return known;
    const entry: ReviewerEntry = { key: person.login, person, reviews: [] };
    entries.set(person.login, entry);
    return entry;
  };
  for (const person of states ?? []) entryFor(person).state = person.state;
  for (const person of pull.reviewers) entryFor(person);
  for (const review of reviews) {
    const author = review.author;
    if (!author) continue;
    const reviewer: RepositoryReferenceReviewer = author.avatarUrl
      ? { id: author.login, login: author.login, avatarUrl: author.avatarUrl }
      : { id: author.login, login: author.login };
    entryFor(reviewer).reviews.push(review);
  }
  if (states === undefined && reviews.length === 0) return [...entries.values()];
  for (const entry of entries.values()) {
    const latest = entry.reviews[0];
    if (latest?.state === 'dismissed') entry.state = 'dismissed';
    else if (latest && (entry.state === undefined || entry.state === 'pending')) entry.state = latest.state;
    else if (entry.state === undefined) entry.state = 'pending';
  }
  return [...entries.values()].sort((left, right) => STATE_ORDER[left.state ?? 'pending'] - STATE_ORDER[right.state ?? 'pending']);
};
