import { openExternalUrl } from '@/lib/url';

/*
 * Every "open / generate the AI walkthrough" action (the diff toolbar, the
 * pull request header, Generate in the walkthrough) is the plain outline
 * button. Colour is kept for state: a tint said "info" or "working" on a
 * button that is neither, and it competed with the one primary action beside
 * it (AI Review, Merge).
 *
 * No sparkle iconography: "this is AI" is not what the button does, and the
 * cliché tells the user nothing about the outcome.
 */

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
