import type { Element, Root, ElementContent } from 'hast';
import { z } from 'zod';
import { isAppLinkUrl } from '@/lib/url';
import { isSessionDeepLink } from '@/lib/sessionLinks';

const allowedAttributes = new Set(['align', 'alt', 'checked', 'colSpan', 'controls', 'disabled', 'height', 'href', 'media', 'open', 'playsInline', 'preload', 'rel', 'rowSpan', 'src', 'srcSet', 'start', 'target', 'title', 'type', 'width']);
const urlAttribute = z.string();

function localFile(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost');
  } catch { return false; }
}

function relativeOrHttp(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (/^[\s\\]*[/\\]{2}/.test(value) || value.includes('\\')) return false;
  return /^https?:\/\//i.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value);
}

function safeLink(value: string, vscode: boolean): boolean {
  if (value !== value.trim() || /\s/.test(value)) return false;
  return relativeOrHttp(value) || localFile(value) || isAppLinkUrl(value)
    || /^(?:mailto|tel|sms|callto|cid|xmpp|irc|ircs|news|nntp|feed|webcal):/i.test(value)
    || (!vscode && isSessionDeepLink(value));
}

export function rehypeMarkdownPolicy({ isVSCode }: { isVSCode: boolean }) {
  return (tree: Root, file: { toString(): string }) => {
    const source = file.toString();
    function walk(parent: Root | Element): void {
      const children: ElementContent[] = [];
      for (const node of parent.children) {
        if (node.type === 'doctype') continue;
        if (node.type !== 'element') { children.push(node); continue; }
        if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form'].includes(node.tagName)) continue;
        const start = node.position?.start?.offset;
        const authored = start !== undefined && source[start] === '<';
        // Only checkboxes survive, and the sanitizer disables them.
        if (node.tagName === 'input' && node.properties.type !== 'checkbox') continue;
        for (const key of Object.keys(node.properties)) {
          // A document's own `<code class="language-x">` keeps its language;
          // every other author class could reach the app's utility classes.
          const authoredLanguage = authored && key === 'className' && node.tagName === 'code'
            && Array.isArray(node.properties.className)
            && node.properties.className.every((name) => /^language-[\w#+.-]+$/.test(String(name)));
          const generated = authoredLanguage || !authored && (
            (key === 'className' && ['code', 'li', 'ul', 'ol', 'section', 'h2', 'a'].includes(node.tagName))
            || (key === 'metastring' && node.tagName === 'code')
            || ['id', 'ariaDescribedBy', 'ariaLabel', 'dataFootnoteRef', 'dataFootnoteBackref', 'dataFootnotes'].includes(key)
            || (key === 'dataOcAlert' && node.tagName === 'blockquote')
            || (key === 'dataOcReference' && node.tagName === 'a')
          );
          if (!allowedAttributes.has(key) && !generated) delete node.properties[key];
        }
        if (node.properties.href !== undefined) {
          const href = urlAttribute.safeParse(node.properties.href);
          if (href.success && safeLink(href.data, isVSCode)) node.properties.dataOcLinkSource = href.data;
          else delete node.properties.href;
        }
        if (node.tagName === 'a') node.properties.href = '#oc-link';
        if (node.properties.src !== undefined) {
          const parsed = urlAttribute.safeParse(node.properties.src);
          if (parsed.success) {
            const src = parsed.data;
            const embeddedImage = node.tagName === 'img' && /^data:image\/(?:png|jpeg|gif|webp);base64,(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/i.test(src);
            if (src === src.trim() && (relativeOrHttp(src) || localFile(src) || embeddedImage)) {
              node.properties.dataOcMediaSource = src;
              if (localFile(src)) delete node.properties.src;
            } else delete node.properties.src;
          } else delete node.properties.src;
        }
        if (node.tagName === 'img') node.properties.src = '/__oc_markdown_media__';
        if (node.properties.srcSet !== undefined) {
          const srcSet = urlAttribute.safeParse(node.properties.srcSet);
          const valid = srcSet.success && srcSet.data.split(',').every(candidate => {
            const [url, descriptor, ...rest] = candidate.trim().split(/\s+/);
            return Boolean(url) && relativeOrHttp(url) && rest.length === 0 && (!descriptor || /^(?:\d+w|\d+(?:\.\d+)?x)$/.test(descriptor));
          });
          if (!valid) delete node.properties.srcSet;
        }
        for (const size of ['width', 'height']) {
          if (node.properties[size] !== undefined && !/^\d+(?:\.\d+)?%?$/.test(String(node.properties[size]))) delete node.properties[size];
        }
        if (node.tagName === 'video') {
          node.properties.controls = true;
          node.properties.playsInline = true;
          node.properties.preload = 'none';
        }
        walk(node);
        children.push(node);
      }
      parent.children = children;
    }
    walk(tree);
  };
}

// Harden may normalize or remove custom schemes. Only validated generated
// values survive the sanitizer and can restore the application navigation URL.
export function rehypeRestoreMarkdownLinks() {
  return (tree: Root) => {
    function walk(parent: Root | Element): void {
      for (const node of parent.children) {
        if (node.type !== 'element') continue;
        if (node.tagName === 'a') {
          const href = urlAttribute.safeParse(node.properties.dataOcLinkSource);
          if (href.success) node.properties.href = href.data;
          else delete node.properties.href;
          delete node.properties.dataOcLinkSource;
        }
        if (node.tagName === 'img') {
          const source = urlAttribute.safeParse(node.properties.dataOcMediaSource);
          if (source.success && !localFile(source.data) && !/^data:/i.test(source.data)) node.properties.src = source.data;
          else delete node.properties.src;
        }
        walk(node);
      }
    }
    walk(tree);
  };
}
