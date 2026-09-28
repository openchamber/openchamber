import { GUEST_SCROLLBAR_CSS, GUEST_SCROLLBAR_SCRIPT } from '@openchamber/sdk';

// The panel iframe inherits the host's dark color scheme, and a document that
// does not declare one gets an opaque white canvas until its own theme loads:
// a white flash on every mount (issue #4017). The declaration has to precede
// the first paint, so it goes first: right after a leading doctype (matched
// only at the very start, never inside authored markup), else before all.
const GUEST_COLOR_SCHEME_META = '<meta name="color-scheme" content="light dark">';
const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

const declareColorScheme = (html) => {
  const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? '';
  return `${doctype}${GUEST_COLOR_SCHEME_META}${html.slice(doctype.length)}`;
};

/** Append instead of matching tags inside untrusted comments, scripts, or templates (the one
 * exception is the color-scheme meta, placed after a leading doctype; see above).
 * Browsers accept the style and script after the document; its doctype and authored CSP stay intact.
 * The script only marks scrolling elements so their scrollbars show while scrolling; an authored
 * CSP that blocks inline scripts leaves the hover-only behavior of the stylesheet.
 */
export const injectGuestDocumentStyles = (html) => `${declareColorScheme(html)}\n<style data-openchamber-guest-styles>${GUEST_SCROLLBAR_CSS}</style>\n<script data-openchamber-guest-scrollbar>${GUEST_SCROLLBAR_SCRIPT}</script>`;
