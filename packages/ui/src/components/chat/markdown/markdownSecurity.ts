/** Raw HTML stays inert; supported disclosures are constructed by the Markdown tokenizer. */
export const escapeRawMarkdownHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Active elements forbidden again at the final DOMPurify boundary. */
export const MARKDOWN_FORBIDDEN_TAGS = ['script', 'style'] as const;

/**
 * Raw HTML a Markdown document keeps where a surface renders documents rather
 * than assistant output (the Files preview): roughly GitHub's allowlist. Author
 * styles, ids, data attributes, event handlers, forms and embeds are dropped.
 * The data attributes listed are the ones the Markdown renderer itself emits.
 */
export const DOCUMENT_HTML_ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol',
  'p', 'picture', 'pre', 'q', 's', 'samp', 'source', 'span', 'strike', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'ul', 'var',
] as const;

export const DOCUMENT_HTML_ALLOWED_ATTR = [
  'align', 'alt', 'checked', 'class', 'colspan', 'disabled', 'height', 'href', 'media', 'open',
  'rel', 'rowspan', 'src', 'srcset', 'start', 'target', 'title', 'type', 'width',
  'data-md-details', 'data-oc-math', 'data-openchamber-agent-mention', 'data-skill-name',
] as const;

// Author classes would reach the app's utility classes (`fixed inset-0 ...`),
// so only the classes the Markdown renderer itself emits survive.
const GENERATED_MARKDOWN_CLASS_RE = /^(?:external-link|text-primary hover:underline|language-[\w#+.-]+)$/;

export const isGeneratedMarkdownClass = (value: string): boolean => GENERATED_MARKDOWN_CLASS_RE.test(value.trim());

/** Every `srcset` candidate is a relative path or an http(s) URL. */
export const isSafeSrcset = (value: string): boolean => value.split(',').every((candidate) => {
  const url = candidate.trim().split(/\s+/, 1)[0] ?? '';
  if (!url) return false;
  return /^https?:\/\//i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url);
});

export const isLocalFileUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'file:' && (!parsed.hostname || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
};
