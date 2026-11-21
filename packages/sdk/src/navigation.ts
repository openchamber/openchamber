import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import type { GuestOpenCommitMessage, GuestOpenWalkthroughMessage } from './contract.ts';

export type OpenCommitRequest = {
  sha: string;
};

export const GUEST_COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

export const isGuestCommitSha = (value: string): boolean => GUEST_COMMIT_SHA.test(value);

export type OpenWalkthroughRequest = {
  base: string;
};

export const GUEST_WALKTHROUGH_BASE_MAX = 255;

export type GuestNavigationClient = {
  openCommit: (sha: string) => Promise<void>;
  openWalkthrough: (request: OpenWalkthroughRequest) => Promise<void>;
};

export const guestNavigationCalls = (
  request: (message: GuestOpenCommitMessage | GuestOpenWalkthroughMessage) => Promise<void>,
  nextId: () => string,
  refuse: (message: string) => Promise<never>,
): GuestNavigationClient => ({
  openCommit: (sha) => (isGuestCommitSha(sha)
    ? request({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'open-commit', id: nextId(), payload: { sha } })
    : refuse('Commit id must be 7 to 64 hex characters.')),
  openWalkthrough: ({ base }) => {
    const trimmed = base.trim();
    if (!trimmed || trimmed.length > GUEST_WALKTHROUGH_BASE_MAX) return refuse(`Base must contain 1 to ${GUEST_WALKTHROUGH_BASE_MAX} characters.`);
    return request({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'open-walkthrough', id: nextId(), payload: { base: trimmed } });
  },
});
