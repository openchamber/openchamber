import { z } from 'zod';

/**
 * The document of a shared `ui` page: the program as JSON and the renderer
 * bundle (`entry.tsx`, built into `share-document.js`) inline, so it needs
 * nothing from the network. The relay's viewer runs it in a sandboxed srcdoc
 * frame whose policy allows inline scripts and styles only.
 */

export const SHARE_PAGE_DATA_ID = 'oc-share-page';
export const SHARE_PAGE_ROOT_ID = 'oc-share-root';

/** `expectAnswer` false: a page the recipients only read, with no form to send. */
export const sharePageDataSchema = z.object({ ui: z.string().min(1), title: z.string(), expectAnswer: z.boolean().catch(true) });

const escapeHtml = (text: string): string => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Inside a script element the HTML parser ends the script at "</script" and
// changes state at "<!--", wherever they stand in the code (a string, a
// regular expression). `\x3C` is the same "<" to JavaScript in a string, a
// template and a regular expression, `u` flag included.
const inlineScriptText = (code: string): string => code.replace(/<(\/script|!--)/gi, '\\x3C$1');

/** The whole document for a `ui` page; `bundle` is the text of `share-document.js`. */
export function buildShareUiDocument({ ui, title, expectAnswer, bundle }: { ui: string; title: string; expectAnswer: boolean; bundle: string }): string {
  const data = JSON.stringify(sharePageDataSchema.parse({ ui, title, expectAnswer })).replace(/</g, '\\u003c');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<script type="application/json" id="${SHARE_PAGE_DATA_ID}">${data}</script>`,
    `</head><body><div id="${SHARE_PAGE_ROOT_ID}"></div>`,
    `<script>${inlineScriptText(bundle)}</script>`,
    '</body></html>',
  ].join('');
}
