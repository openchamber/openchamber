import { openExternalUrl } from '@/lib/url';

/**
 * Shared chrome for every "open / generate the AI walkthrough" action.
 *
 * The walkthrough is informational rather than a primary or destructive act, so
 * it carries the info status tint instead of competing with the primary button
 * next to it (Review in the diff toolbar, Merge in the pull request header).
 * Keeping it in one constant is what stops the three entry points from drifting
 * apart.
 *
 * No sparkle iconography: "this is AI" is not what the button does, and the
 * cliché tells the user nothing about the outcome.
 */
export const WALKTHROUGH_ACTION_CLASS =
  'border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)] hover:bg-[var(--status-info-background)] hover:text-[var(--status-info)]';

// What a walkthrough is — and what it deliberately is not — cannot be read off
// the panel: the first question users asked about it was whether its marks were
// review findings. The guide answers that, so it is reachable from the surface
// itself rather than only from the release announcement.
const WALKTHROUGH_GUIDE_URL = 'https://docs.openchamber.dev/walkthrough/';

export const openWalkthroughGuide = () => {
  void openExternalUrl(WALKTHROUGH_GUIDE_URL);
};

// DropdownMenuLabel defaults to the same size and weight as its items, which
// makes a heading read as another choice. This matches SelectLabel, the
// treatment used by the worktree picker.
export const MENU_GROUP_LABEL_CLASS = 'typography-meta font-normal text-muted-foreground';
