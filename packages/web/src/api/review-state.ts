import type {
  ChangeRequestReviewerState,
  ReviewerStateValue,
  SourceControlIdentity,
  SourceControlUser,
} from '@openchamber/ui/lib/api/types';

interface UserWire {
  id: string | number;
  provider?: string;
  instance?: string;
  username?: string;
  login?: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
}

type ParseUser = (user: UserWire, identity: SourceControlIdentity) => SourceControlUser;

const REVIEWER_STATES: readonly ReviewerStateValue[] = ['pending', 'approved', 'changes_requested', 'commented', 'dismissed'];

export const parseReviewerStates = (
  entries: ChangeRequestReviewerState[],
  identity: SourceControlIdentity,
  parseUser: ParseUser,
): ChangeRequestReviewerState[] | undefined => {
  if (!Array.isArray(entries)) return undefined;
  return entries.flatMap((entry) => {
    const state = REVIEWER_STATES.find((candidate) => candidate === entry?.state);
    if (!entry || !state) return [];
    try {
      return [{ user: parseUser(entry.user, identity), state }];
    } catch {
      return [];
    }
  });
};
