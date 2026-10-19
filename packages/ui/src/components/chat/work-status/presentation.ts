/**
 * The work-status card has two forms: docked in the right slot beside the
 * chat, and floating over the chat when the slot belongs to a context panel
 * or the window leaves no room. Both are gates on the same card, so they are
 * decided together; two expressions at the call site drift apart the moment
 * either rule changes.
 */

type WorkStatusPresentationInput = {
  /** This surface hosts the panel at all (not mobile, VS Code, mini chat or a split column). */
  mountable: boolean;
  /** The user's persisted switch. */
  enabled: boolean;
  /** The layout can give the card its column beside the chat. */
  fits: boolean;
  /** The layout has actually measured the chat area; before that `fits` is meaningless. */
  measured: boolean;
  /** The user asked the card to stay when a right-zone surface opens. */
  pinned: boolean;
  /** The header's "show over the chat" toggle for a window too narrow to dock. */
  overlayOpen: boolean;
};

type WorkStatusPresentation = {
  /** Docked in the right slot. */
  inline: boolean;
  /** Floating over the chat. */
  overlay: boolean;
};

export const resolveWorkStatusPresentation = ({
  mountable,
  enabled,
  fits,
  measured,
  pinned,
  overlayOpen,
}: WorkStatusPresentationInput): WorkStatusPresentation => {
  if (!mountable || !enabled) return { inline: false, overlay: false };
  // The first frame after a reload has no width yet. Showing the floating form
  // there painted it for one commit and then jumped it into its column.
  if (!measured) return { inline: false, overlay: false };
  if (fits) return { inline: true, overlay: false };
  // No column: the panel floats when the user asked for it here, or when the
  // pin says it must not disappear just because a surface took the slot.
  return { inline: false, overlay: overlayOpen || pinned };
};
