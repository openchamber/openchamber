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
