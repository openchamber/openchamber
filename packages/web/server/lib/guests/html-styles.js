import { GUEST_SCROLLBAR_CSS, GUEST_SCROLLBAR_SCRIPT } from '@openchamber/sdk';

/** Append instead of matching tags inside untrusted comments, scripts, or templates.
 * Browsers accept the style and script after the document; its doctype and authored CSP stay intact.
 * The script only marks scrolling elements so their scrollbars show while scrolling; an authored
 * CSP that blocks inline scripts leaves the hover-only behavior of the stylesheet.
 */
export const injectGuestDocumentStyles = (html) => `${html}\n<style data-openchamber-guest-styles>${GUEST_SCROLLBAR_CSS}</style>\n<script data-openchamber-guest-scrollbar>${GUEST_SCROLLBAR_SCRIPT}</script>`;
