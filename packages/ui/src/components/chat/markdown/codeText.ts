/**
 * The source text of a rendered markdown code block. Once line numbers are laid
 * out, each source line lives in its own `[data-md-code-line-content]` span.
 */
export const getMarkdownCodeText = (code: HTMLElement): string => {
  const lineContents = Array.from(code.querySelectorAll<HTMLElement>('[data-md-code-line-content]'));
  if (lineContents.length === 0) return code.textContent ?? '';
  const text = lineContents.map((line) => line.textContent ?? '').join('\n');
  return code.hasAttribute('data-md-code-trailing-newline') ? `${text}\n` : text;
};
