/**
 * The page an office document is drawn in. A document is somebody else's
 * content, and the renderers turn its text and links into HTML, so the page is
 * cleaned, runs in a sandbox with an opaque origin, and cannot reach the
 * network: nothing in a file can read the app or report that it was opened.
 */

const REMOVED_ELEMENTS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'form',
  'input', 'button', 'select', 'textarea', 'audio', 'video', 'source', 'track', 'template', 'noscript',
  'animate', 'animateTransform', 'animateMotion', 'set',
].join(',');

const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'background', 'poster', 'ping']);

const isEmbedded = (value: string): boolean => /^\s*(?:#|data:image\/)/i.test(value);

/** Keeps a document's look and drops what acts: scripts, handlers, and every URL outside the file. */
export const cleanDocumentHtml = (html: string): string => {
  const page = new DOMParser().parseFromString(html, 'text/html');
  for (const element of Array.from(page.querySelectorAll(REMOVED_ELEMENTS))) element.remove();
  for (const element of Array.from(page.body.querySelectorAll('*'))) {
    for (const { name, value } of Array.from(element.attributes)) {
      const attribute = name.toLowerCase();
      if (attribute.startsWith('on')) {
        element.removeAttribute(name);
      } else if (URL_ATTRIBUTES.has(attribute) && !isEmbedded(value)) {
        element.removeAttribute(name);
        // A link stays readable: hovering it shows where it pointed.
        if (element.localName === 'a') element.setAttribute('title', value);
      }
    }
  }
  return page.body.innerHTML;
};

const FRAME_STYLE = `
html, body { margin: 0; background: transparent; }
html { scrollbar-width: thin; scrollbar-color: rgb(128 128 128 / 50%) transparent; }
#oc-fit { width: max-content; margin-inline: auto; padding-block: 8px; }
.docx-wrapper { background: transparent !important; padding: 0 8px !important; }
.docx-wrapper > section.docx { margin-bottom: 8px !important; box-shadow: none !important; }
/* The renderer puts a slide's background at z-index -1, which needs a stacking context of its own. */
.slide { margin: 0 8px 8px; isolation: isolate; }
.oc-page {
  box-sizing: border-box; width: 100vw; max-width: 816px; padding: 48px; background: #fff; color: #1f1f1f;
  font: 16px/1.5 system-ui, sans-serif; overflow-wrap: anywhere; white-space: pre-wrap;
}
.oc-page img { display: block; max-width: 100%; height: auto; }
`;

// Paper keeps its size until the pane is narrower than the page, then scales
// down with it. Without the script (a host's CSP) the page scrolls sideways.
const FIT_SCRIPT = `
const fit = document.getElementById('oc-fit');
const apply = () => {
  fit.style.zoom = '1';
  fit.style.zoom = String(Math.max(0.25, Math.min(1, document.documentElement.clientWidth / fit.scrollWidth)));
};
addEventListener('resize', apply);
apply();
`;

export const officeFrameDocument = (body: string, styles: string = ''): string => {
  const nonce = crypto.randomUUID();
  const policy = `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${policy}">`
    // The document's own rules travel as text, so they must not close the tag.
    + `<style>${styles.replace(/<\/style/gi, '<\\/style')}</style><style>${FRAME_STYLE}</style></head>`
    + `<body><div id="oc-fit">${cleanDocumentHtml(body)}</div><script nonce="${nonce}">${FIT_SCRIPT}</script></body></html>`;
};
