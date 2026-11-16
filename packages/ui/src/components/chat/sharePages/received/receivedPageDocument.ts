import type { JsonValue } from '@/lib/opencode/model';

/**
 * Someone else's page, prepared to run inside the app as the relay's viewer
 * runs it: no network, no navigation, and the answer it already sent there
 * before its own scripts run.
 */

// The relay viewer's own policy for the page (viewer.ts, DOC_CSP).
const DOCUMENT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

// The shell between the app and the page, loaded as a data: URL, so it is an
// opaque origin of its own. Two things depend on that:
// - A frame's navigation of itself is checked against its embedder's
//   frame-src, which the app cannot set for itself, so the page sits one level
//   down, inside this document whose policy allows no frame navigation (its
//   srcdoc child still loads) and no requests. Chromium enforces it only while
//   the shell is not sandboxed: a sandboxed shell let `location.replace` out.
// - A gesture anywhere in the app activates every same-origin frame, so a
//   shell in the app's origin (an unsandboxed srcdoc) was active whenever the
//   user typed in the composer. Cross-origin, only a gesture in the shell or
//   the page below it activates it. Checked in Chromium 157.
const SHELL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; child-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** The source of the app's one message to the shell: the page to show. */
export const SHARE_HOST_SOURCE = 'openchamber-share-host';

/** The id of the page's saved answer, read by the HTML page bootstrap (`shareDocument.ts`). */
export const SHARE_ANSWER_ELEMENT_ID = 'oc-share-answer';

const scriptJson = (value: JsonValue | string) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * The page with its policy as the first element of its head, ahead of any
 * script, wherever the author put one (markup before `<html>` lands in the
 * head too), and with the answer already sent, when there is one, right
 * after it, so an HTML page reads `openchamber.answer` as its scripts start.
 */
export function lockDownReceivedDocument(html: string, answer: JsonValue | null): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const head = parsed.head;
  if (answer !== null) {
    const data = parsed.createElement('script');
    data.type = 'application/json';
    data.id = SHARE_ANSWER_ELEMENT_ID;
    data.textContent = scriptJson(answer);
    head.insertBefore(data, head.firstChild);
  }
  const meta = parsed.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = DOCUMENT_CSP;
  head.insertBefore(meta, head.firstChild);
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

// Shows the page the app hands over once, then forwards the viewer protocol
// both ways and nothing else: a message the protocol does not name is dropped,
// a forwarded one is rebuilt from its known fields. A page's answer goes up
// only while the shell holds transient activation that began after the page
// was shown: the shell polls the activation and arms once it reads inactive,
// so a gesture that led to the page (the click on Open) cannot carry a
// load-time submit. Without that the page hears `__REFUSAL__` and nothing
// reaches the app. A runtime without the activation API (iOS before 16.4)
// cannot tell, so there the answer goes up marked `verified: false` and the
// app asks the user before sending it. The page's own `openchamber.submit`
// checks a click too, but the page is not ours.
const SHELL_SCRIPT = '(function(){var f=document.querySelector("iframe"),shown=false,ready=false,armed=false,poll=null,held=[],DS="openchamber-share-document",VS="openchamber-share-viewer",HS=__HOST__;'
  + 'function object(d){return d!==null&&typeof d==="object";}'
  + 'var known=!!navigator.userActivation;function active(){return known&&navigator.userActivation.isActive;}'
  + 'function arm(){armed=false;clearInterval(poll);if(!known)return;poll=setInterval(function(){if(!active()){armed=true;clearInterval(poll);}},200);}'
  + 'function fromViewer(d){if(!object(d)||d.source!==VS)return null;'
  + 'if(d.type==="init"){var m={source:VS,type:"init",wantsAnswer:d.wantsAnswer===true,locale:typeof d.locale==="string"?d.locale:null};if(d.answer!==undefined)m.answer=d.answer;return m;}'
  + 'if(d.type==="submit-result")return{source:VS,type:"submit-result",ok:d.ok===true,error:typeof d.error==="string"?d.error:null};return null;}'
  + 'window.addEventListener("message",function(e){if(e.source===f.contentWindow){var d=e.data;'
  + 'if(!object(d)||d.source!==DS||d.type!=="submit"||typeof d.summary!=="string")return;'
  + 'if(known&&!(armed&&active())){f.contentWindow.postMessage({source:VS,type:"submit-result",ok:false,error:__REFUSAL__},"*");return;}'
  + 'window.parent.postMessage({source:DS,type:"submit",data:d.data===undefined?null:d.data,summary:d.summary,verified:known},"*");return;}'
  + 'if(e.source!==window.parent)return;var d2=e.data;'
  + 'if(object(d2)&&d2.source===HS&&d2.type==="page"&&typeof d2.page==="string"){if(!shown){shown=true;f.srcdoc=d2.page;}return;}'
  + 'var m=fromViewer(d2);if(!m)return;if(ready)f.contentWindow.postMessage(m,"*");else held.push(m);});'
  + 'f.addEventListener("load",function(){ready=true;arm();held.splice(0).forEach(function(m){f.contentWindow.postMessage(m,"*");});});})();';

/**
 * The address the app's frame loads: the shell, as a data: URL (small; the
 * page comes as the app's first message, `SHARE_HOST_SOURCE` `page`).
 * `refusal` is what a page hears when it answers without a click.
 */
export function buildReceivedPageShell(colorScheme: 'light' | 'dark', refusal: string): string {
  const style = `html,body{margin:0;height:100%;color-scheme:${colorScheme}}iframe{display:block;border:0;width:100%;height:100%;color-scheme:${colorScheme}}`;
  const script = SHELL_SCRIPT.replace('__REFUSAL__', () => scriptJson(refusal)).replace('__HOST__', () => scriptJson(SHARE_HOST_SOURCE));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SHELL_CSP}"><style>${style}</style></head>`
    + `<body><iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><script>${script}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
