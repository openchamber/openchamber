import { GUEST_SCROLLBAR_CSS, GUEST_SCROLLBAR_SCRIPT } from '@openchamber/sdk';
import { GUEST_UI_LOOK_CSS } from '@openchamber/sdk/ui';

// external: #4017 Declare the inherited color scheme before first paint to prevent a white iframe canvas.
const GUEST_COLOR_SCHEME_META = '<meta name="color-scheme" content="light dark">';
const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

const declareColorScheme = (html) => {
  const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? '';
  return `${doctype}${GUEST_COLOR_SCHEME_META}${html.slice(doctype.length)}`;
};

export const injectGuestDocumentStyles = (html) => `${declareColorScheme(html)}\n<style data-openchamber-guest-styles>${GUEST_SCROLLBAR_CSS}${GUEST_UI_LOOK_CSS}</style>\n<script data-openchamber-guest-scrollbar>${GUEST_SCROLLBAR_SCRIPT}</script>`;
