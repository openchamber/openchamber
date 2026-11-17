import type { JsonValue } from '@/lib/opencode/model';


const DOCUMENT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const SHELL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; child-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

export const SHARE_HOST_SOURCE = 'openchamber-share-host';

export const SHARE_ANSWER_ELEMENT_ID = 'oc-share-answer';

const scriptJson = (value: JsonValue | string) => JSON.stringify(value).replace(/</g, '\\u003c');

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

export function buildReceivedPageShell(colorScheme: 'light' | 'dark', refusal: string): string {
  const style = `html,body{margin:0;height:100%;color-scheme:${colorScheme}}iframe{display:block;border:0;width:100%;height:100%;color-scheme:${colorScheme}}`;
  const script = SHELL_SCRIPT.replace('__REFUSAL__', () => scriptJson(refusal)).replace('__HOST__', () => scriptJson(SHARE_HOST_SOURCE));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SHELL_CSP}"><style>${style}</style></head>`
    + `<body><iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><script>${script}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
