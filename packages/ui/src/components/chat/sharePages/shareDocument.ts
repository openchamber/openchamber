import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, getThemeById } from '@/lib/theme/themes';
import { buildShareUiDocument } from '@/share-document/page';
import { SHARE_DOCUMENT_SOURCE, SHARE_VIEWER_SOURCE } from '@/share-document/protocol';
import { htmlRenderSchemeCss, htmlRenderTheme, insertHeadMarkup, type HtmlRenderMetrics } from '../message/parts/htmlRender';

/**
 * The self-contained document a shared page becomes. The server only encrypts
 * and uploads it; the relay's viewer shows it to each recipient in a sandboxed
 * srcdoc frame that allows inline scripts and styles and data: images, and no
 * network. So the document carries everything: OpenChamber's default light
 * and dark themes (the reader's system picks one, the author's own theme is
 * the author's), the page's ready classes, and for a `ui` page the UI block
 * renderer itself.
 */

// The reader is not in the app, so the page takes the app's default sizes and
// the system font the viewer around it uses.
const SHARE_METRICS: HtmlRenderMetrics = {
    rem: 16,
    text: 15,
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono: 'ui-monospace, "SFMono-Regular", Menlo, "Cascadia Mono", "Segoe UI Mono", monospace',
};

// The page fills the viewer on the theme's own background at full width; an
// html page sets its own reading width, as it does in the chat column.
const SHARE_PAGE_CSS = 'html{background:var(--background)}body{box-sizing:border-box;margin:0;padding:24px 16px 40px}';

// `openchamber.submit(data, summary)` sends the answer to the viewer and
// settles on its reply, one answer on its way at a time, none after one went
// through, only from a click (the viewer checks the share takes an answer).
// `openchamber.answer` stays null: a shared page is never shown again after
// its answer, the viewer shows its own "sent" screen. A link can only scroll
// within the page; the frame cannot navigate.
const SHARE_ANSWER_SCRIPT = `(function(){if(window.parent===window)return;var W=null,P=null,D=false,DS=${JSON.stringify(SHARE_DOCUMENT_SOURCE)},VS=${JSON.stringify(SHARE_VIEWER_SOURCE)};`
    + `window.openchamber={answer:null,submit:function(data,summary){return new Promise(function(res,rej){var v;`
    + `if(D)return rej(new Error("The answer was already sent"));if(W===false)return rej(new Error("This page does not take an answer"));`
    + `if(P)return rej(new Error("An answer is already on its way"));`
    + `if(navigator.userActivation&&!navigator.userActivation.isActive)return rej(new Error("openchamber.submit works only from a click"));`
    + `if(typeof summary!=="string"||!summary.trim())return rej(new Error("summary is required: the choice in a few words"));`
    + `try{v=JSON.parse(JSON.stringify(data===undefined?null:data));}catch(x){return rej(x);}`
    + `P={res:res,rej:rej};window.parent.postMessage({source:DS,type:"submit",data:v,summary:summary.trim()},"*");});}};`
    + `window.addEventListener("message",function(e){var d=e.data,p;if(e.source!==window.parent||!d||d.source!==VS)return;`
    + `if(d.type==="init"){W=d.wantsAnswer===true;return;}`
    + `if(d.type==="submit-result"&&P){p=P;P=null;if(d.ok===true){D=true;p.res();}else p.rej(new Error(typeof d.error==="string"&&d.error?d.error:"The answer was not sent"));}});`
    + `document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null;if(a&&(a.getAttribute("href")||"").charAt(0)!=="#")e.preventDefault();},true);})();`;

const defaultTheme = (id: string) => {
    const theme = getThemeById(id);
    if (!theme) throw new Error(`The built-in theme ${id} is missing`);
    return htmlRenderTheme(theme, SHARE_METRICS);
};

/** An `html` page as the recipients get it; `html` already has its local images inlined. */
export function buildShareHtmlDocument(html: string): string {
    const css = htmlRenderSchemeCss(defaultTheme(DEFAULT_LIGHT_THEME_ID), defaultTheme(DEFAULT_DARK_THEME_ID)) + SHARE_PAGE_CSS;
    return insertHeadMarkup(html, `<style>${css}</style><script>${SHARE_ANSWER_SCRIPT}</script>`);
}

const SHARE_DOCUMENT_BUNDLE = 'share-document.js';

let bundleRequest: Promise<string> | null = null;

/**
 * The UI block renderer a `ui` page carries, built next to the app's own
 * assets (`packages/web/vite-share-document.ts`). It is part of the app, not
 * of the runtime it talks to: a phone app holds it in its own bundle while its
 * server is elsewhere, so it is read from where the app was loaded, with plain
 * fetch. Kept once read; a failed read is tried again next time.
 */
function loadShareDocumentBundle(): Promise<string> {
    bundleRequest ??= fetch(new URL(`${import.meta.env.BASE_URL}${SHARE_DOCUMENT_BUNDLE}`, window.location.href), { cache: 'no-cache' })
        .then(async (response) => {
            if (!response.ok) throw new Error(`The page renderer could not be loaded (${response.status})`);
            return response.text();
        })
        .catch((error) => {
            bundleRequest = null;
            throw error;
        });
    return bundleRequest;
}

/** The document for a shared page: a `ui` program with the renderer, or an `html` page. */
export async function buildSharePageDocument(page: { ui?: string; html: string; title: string; expectAnswer: boolean }): Promise<string> {
    if (page.ui) return buildShareUiDocument({ ui: page.ui, title: page.title, expectAnswer: page.expectAnswer, bundle: await loadShareDocumentBundle() });
    return buildShareHtmlDocument(page.html);
}
