import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, getThemeById } from '@/lib/theme/themes';
import { buildShareUiDocument } from '@/share-document/page';
import { SHARE_DOCUMENT_SOURCE, SHARE_VIEWER_SOURCE } from '@/share-document/protocol';
import { SANDBOX_STORAGE_SCRIPT } from '@/lib/browser/sandboxStorage';
import { htmlRenderSchemeCss, htmlRenderTheme, insertHeadMarkup, type HtmlRenderMetrics } from '../message/parts/htmlRender';
import { SHARE_ANSWER_ELEMENT_ID } from './received/receivedPageDocument';
import { fetchBypassingRuntimeBridge } from '@/lib/runtime-fetch';

const SHARE_METRICS: HtmlRenderMetrics = {
    rem: 16,
    text: 15,
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono: 'ui-monospace, "SFMono-Regular", Menlo, "Cascadia Mono", "Segoe UI Mono", monospace',
};

const SHARE_PAGE_CSS = 'html{background:var(--background);overflow-y:auto!important}'
    + 'body{box-sizing:border-box;margin:0;padding:24px 16px 40px;overflow-y:visible!important}';

const SHARE_ANSWER_SCRIPT = `(function(){if(window.parent===window)return;var W=null,P=null,D=false,A=null,E=document.getElementById(${JSON.stringify(SHARE_ANSWER_ELEMENT_ID)}),DS=${JSON.stringify(SHARE_DOCUMENT_SOURCE)},VS=${JSON.stringify(SHARE_VIEWER_SOURCE)};`
    + `if(E){try{A=JSON.parse(E.textContent);D=A!==null;}catch(x){}}`
    + `window.openchamber={answer:A,submit:function(data,summary){return new Promise(function(res,rej){var v;`
    + `if(D)return rej(new Error("The answer was already sent"));if(W===false)return rej(new Error("This page does not take an answer"));`
    + `if(P)return rej(new Error("An answer is already on its way"));`
    + `if(navigator.userActivation&&!navigator.userActivation.isActive)return rej(new Error("openchamber.submit works only from a click"));`
    + `if(typeof summary!=="string"||!summary.trim())return rej(new Error("summary is required: the choice in a few words"));`
    + `try{v=JSON.parse(JSON.stringify(data===undefined?null:data));}catch(x){return rej(x);}`
    + `P={res:res,rej:rej};window.parent.postMessage({source:DS,type:"submit",data:v,summary:summary.trim()},"*");});}};`
    + `window.addEventListener("message",function(e){var d=e.data,p;if(e.source!==window.parent||!d||d.source!==VS)return;`
    + `if(d.type==="init"){W=d.wantsAnswer===true;if(d.answer!==undefined&&d.answer!==null){window.openchamber.answer=d.answer;D=true;}return;}`
    + `if(d.type==="submit-result"&&P){p=P;P=null;if(d.ok===true){D=true;p.res();}else p.rej(new Error(typeof d.error==="string"&&d.error?d.error:"The answer was not sent"));}});`
    + `document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null;if(a&&(a.getAttribute("href")||"").charAt(0)!=="#")e.preventDefault();},true);})();`;

const defaultTheme = (id: string) => {
    const theme = getThemeById(id);
    if (!theme) throw new Error(`The built-in theme ${id} is missing`);
    return htmlRenderTheme(theme, SHARE_METRICS);
};

export function buildShareHtmlDocument(html: string): string {
    const css = htmlRenderSchemeCss(defaultTheme(DEFAULT_LIGHT_THEME_ID), defaultTheme(DEFAULT_DARK_THEME_ID)) + SHARE_PAGE_CSS;
    return insertHeadMarkup(html, `<style>${css}</style><script>${SANDBOX_STORAGE_SCRIPT}</script><script>${SHARE_ANSWER_SCRIPT}</script>`);
}

const SHARE_DOCUMENT_BUNDLE = 'share-document.js';

let bundleRequest: Promise<string> | null = null;

function loadShareDocumentBundle(): Promise<string> {
    bundleRequest ??= fetchBypassingRuntimeBridge(new URL(`${import.meta.env.BASE_URL}${SHARE_DOCUMENT_BUNDLE}`, window.location.href), { cache: 'no-cache' })
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

export async function buildSharePageDocument(page: { ui?: string; html: string; title: string; expectAnswer: boolean }): Promise<string> {
    if (page.ui) return buildShareUiDocument({ ui: page.ui, title: page.title, expectAnswer: page.expectAnswer, bundle: await loadShareDocumentBundle() });
    return buildShareHtmlDocument(page.html);
}
