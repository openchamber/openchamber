import { getMarkdownSelectionText, serializeRenderedMarkdown } from '../markdown/selectionMarkdown';
import { cloneSelectionAncestor, cloneSelectionContent } from '../markdown/selectionRange';

const normalizeLineBreaks = (value: string): string => value.replace(/\r\n?/g, '\n');
const isElement = (node: Node | null): node is Element => node?.nodeType === 1;
export const trimSelectionValue = (value: string): string => normalizeLineBreaks(value).trim();

export const formatCodeSelectionMarkdown = (code: string, language = ''): string => {
  const normalizedCode = normalizeLineBreaks(code).replace(/\n$/, '');
  const longestBacktickRun = Math.max(0, ...Array.from(normalizedCode.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${normalizedCode}\n${fence}`;
};

export const rangeToMarkdown = (range: Range, plainText: string): string => {
  const markdown = getMarkdownSelectionText(range);
  if (markdown !== null) return markdown;
  // Tool and file selections can contain native code without a Markdown root.
  // Restore its ancestor shells so token rows retain their line structure.
  const fragment = cloneSelectionContent(range);
  const start = isElement(range.startContainer) ? range.startContainer : range.startContainer.parentElement;
  const card = start?.closest('[data-streamdown="code-block"]') ?? start?.closest('pre');
  if (card?.contains(range.endContainer)) {
    let current: Node | null = range.commonAncestorContainer;
    if (current.nodeType === 3) current = current.parentNode;
    while (isElement(current)) {
      const shell = cloneSelectionAncestor(range, current);
      shell.appendChild(fragment);
      fragment.replaceChildren(shell);
      if (current === card) break;
      current = current.parentNode;
    }
  }
  return serializeRenderedMarkdown(fragment) || trimSelectionValue(plainText);
};

export const wrapMarkdownSelectionForChat = (markdown: string): string => {
  const longestBacktickRun = Math.max(0, ...Array.from(markdown.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}md\n${markdown}\n${fence}`;
};
