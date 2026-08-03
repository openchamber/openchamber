/** Raw HTML in assistant markdown is untrusted and must stay inert text. */
export const escapeRawMarkdownHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Active elements forbidden again at the final DOMPurify boundary. */
export const MARKDOWN_FORBIDDEN_TAGS = ['script', 'style'] as const;
