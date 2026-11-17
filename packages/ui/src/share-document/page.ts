import { z } from 'zod';

export const SHARE_PAGE_DATA_ID = 'oc-share-page';
export const SHARE_PAGE_ROOT_ID = 'oc-share-root';

export const sharePageDataSchema = z.object({ ui: z.string().min(1), title: z.string(), expectAnswer: z.boolean().catch(true) });

const escapeHtml = (text: string): string => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// external: https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements `</script` and `<!--` end script data wherever they stand; `\x3C` is the same "<" in strings, templates and regexes.
const inlineScriptText = (code: string): string => code.replace(/<(\/script|!--)/gi, '\\x3C$1');

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
