import { MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE } from '../message/imageExport';
import { getMarkdownCodeText } from './codeText';

// Turns a selection inside rendered chat markdown back into Markdown, so Cmd+C
// on part of a response pastes the formatting the message copy button gives.
//
// The rendered DOM still carries what the source said: code blocks keep their
// language, KaTeX keeps its TeX annotation, mermaid blocks keep their source.
// Decorations the renderer added (toolbars, favicons, line numbers) are
// skipped. Text is not re-escaped: the result is meant to be read and pasted
// into a prompt, not round-tripped byte for byte.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const MARKDOWN_ROOT_SELECTOR = '[data-markdown-content]';

// Renderer chrome that never belongs to the copied content. KaTeX draws each
// formula twice; the formula is read from its TeX annotation instead.
const SKIP_SELECTOR = [
  'button',
  '[data-md-action]',
  '[data-md-menu]',
  '[data-md-code-actions]',
  '[data-markdown="mermaid-toolbar"]',
  '[data-md-disclosure-icon]',
  '[data-openchamber-markdown-image-label-icon]',
  '[data-md-table-measure]',
  `[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}]`,
  '.katex-mathml',
  'colgroup',
  'input:not([type="checkbox"])',
].join(',');

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'FIGURE', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION',
  'SUMMARY', 'TABLE', 'UL',
]);

type Serialized = { block: true; text: string } | { block: false; text: string };

const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;

const isBlockElement = (element: Element): boolean => {
  if (element.matches('.katex-display')) return true;
  if (element.matches('[data-markdown="mermaid-block"], [data-component="markdown-code"], [data-markdown="table-wrapper"]')) return true;
  return BLOCK_TAGS.has(element.tagName);
};

const longestRun = (text: string, char: string): number => {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    current = value === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
};

const fence = (text: string, language: string): string => {
  const marker = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return `${marker}${language}\n${body}${marker}`;
};

const inlineCode = (text: string): string => {
  const marker = '`'.repeat(longestRun(text, '`') + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${marker}${pad}${text}${pad}${marker}`;
};

// Emphasis markers must hug the text: `** bold **` is not bold.
const wrapInline = (text: string, marker: string): string => {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) return text;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
};

const texOf = (katex: Element): string | null => {
  const annotation = katex.querySelector('annotation[encoding="application/x-tex"]');
  return annotation?.textContent?.trim() || null;
};

const codeLanguage = (element: Element): string => {
  const pre = element.tagName === 'PRE' ? element : element.querySelector('pre');
  const explicit = pre?.getAttribute('data-md-lang');
  if (explicit && explicit !== 'text') return explicit;
  const fromClass = pre?.querySelector('code')?.className.match(/language-([\w+#.-]+)/)?.[1];
  return fromClass && fromClass !== 'text' ? fromClass : '';
};

const codeBlockText = (element: Element): string => {
  const code = element.querySelector<HTMLElement>('code');
  return code ? getMarkdownCodeText(code) : element.textContent ?? '';
};

const escapeTableCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

const serializeTable = (table: Element): string => {
  const rows = Array.from(table.querySelectorAll('tr'))
    .map((row) => Array.from(row.children)
      .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
      .map((cell) => escapeTableCell(serializeInlineChildren(cell))))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
  const [head, ...body] = rows;
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
};

const prefixLines = (text: string, first: string, rest: string): string =>
  text.split('\n').map((line, index) => (index === 0 ? first : line ? rest : '') + line).join('\n');

const serializeList = (list: Element): string => {
  const ordered = list.tagName === 'OL';
  let number = Number.parseInt(list.getAttribute('start') ?? '1', 10);
  if (!Number.isFinite(number)) number = 1;
  const items: string[] = [];
  for (const child of Array.from(list.children)) {
    if (child.tagName !== 'LI') continue;
    const marker = ordered ? `${number}. ` : '- ';
    number += 1;
    const checkbox = child.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
    const task = checkbox ? (checkbox.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
    const body = serializeChildren(child, '\n');
    items.push(prefixLines(`${task}${body}`, marker, ' '.repeat(marker.length)));
  }
  return items.join('\n');
};

const serializeBlockElement = (element: Element): string => {
  if (element.matches('[data-markdown="mermaid-block"]')) {
    return fence(element.getAttribute('data-md-source') ?? '', 'mermaid');
  }
  if (element.matches('.katex-display')) {
    const tex = texOf(element);
    return tex ? `$$\n${tex}\n$$` : (element.textContent ?? '');
  }
  if (element.matches('[data-component="markdown-code"]') || element.tagName === 'PRE') {
    return fence(codeBlockText(element), codeLanguage(element));
  }
  if (element.matches('[data-markdown="table-wrapper"]') || element.tagName === 'TABLE') {
    const table = element.tagName === 'TABLE' ? element : element.querySelector('table');
    return table ? serializeTable(table) : '';
  }
  switch (element.tagName) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
      return `${'#'.repeat(Number(element.tagName[1]))} ${serializeInlineChildren(element).trim()}`;
    case 'HR':
      return '---';
    case 'UL': case 'OL':
      return serializeList(element);
    case 'LI':
      // A list item without its list: the selection started inside it.
      return prefixLines(serializeChildren(element, '\n'), '- ', '  ');
    case 'BLOCKQUOTE':
      return serializeChildren(element, '\n\n').split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
    case 'DETAILS': {
      const summary = element.querySelector(':scope > summary');
      const rest = Array.from(element.childNodes).filter((node) => node !== summary);
      const summaryText = summary ? serializeInlineChildren(summary).trim() : '';
      return `<details>\n<summary>${summaryText}</summary>\n\n${serializeNodes(rest, '\n\n')}\n\n</details>`;
    }
    case 'P': case 'SUMMARY':
      return serializeInlineChildren(element).trim();
    default:
      return serializeChildren(element, '\n\n');
  }
};

const serializeInlineElement = (element: Element): string => {
  if (element.matches('.katex')) {
    const tex = texOf(element);
    const rendered = element.querySelector('.katex-html')?.textContent ?? element.textContent ?? '';
    return tex ? `$${tex}$` : rendered;
  }
  const content = () => serializeInlineChildren(element);
  switch (element.tagName) {
    case 'STRONG': case 'B':
      return wrapInline(content(), '**');
    case 'EM': case 'I':
      return wrapInline(content(), '*');
    case 'DEL': case 'S': case 'STRIKE':
      return wrapInline(content(), '~~');
    case 'CODE':
      return inlineCode(element.textContent ?? '');
    case 'BR':
      return '\n';
    case 'IMG': {
      const src = element.getAttribute('src') ?? '';
      return src ? `![${element.getAttribute('alt') ?? ''}](${src})` : '';
    }
    case 'INPUT':
      return '';
    case 'A': {
      const text = content();
      const href = element.getAttribute('href') ?? '';
      // File references were plain paths in the source; keep them as text.
      if (!href || element.getAttribute('data-openchamber-file-link') === 'true') return text;
      if (text.trim() === href) return href;
      return `[${text}](${href})`;
    }
    default:
      return content();
  }
};

const serializeNode = (node: Node): Serialized | null => {
  if (node.nodeType === TEXT_NODE) return { block: false, text: node.textContent ?? '' };
  if (!isElement(node) || node.matches(SKIP_SELECTOR)) return null;
  if (isBlockElement(node)) return { block: true, text: serializeBlockElement(node) };
  return { block: false, text: serializeInlineElement(node) };
};

const serializeNodes = (nodes: readonly Node[], blockSeparator: string): string => {
  const blocks: string[] = [];
  let inline = '';
  const flush = () => {
    const text = inline.trim();
    if (text) blocks.push(text);
    inline = '';
  };
  for (const node of nodes) {
    const serialized = serializeNode(node);
    if (!serialized) continue;
    if (!serialized.block) {
      inline += serialized.text;
      continue;
    }
    flush();
    if (serialized.text.trim()) blocks.push(serialized.text);
  }
  flush();
  return blocks.join(blockSeparator);
};

const serializeChildren = (element: Element, blockSeparator: string): string =>
  serializeNodes(Array.from(element.childNodes), blockSeparator);

function serializeInlineChildren(element: Element): string {
  return Array.from(element.childNodes)
    .map((node) => serializeNode(node)?.text ?? '')
    .join('');
}

/** Markdown for a detached fragment or element of rendered chat markdown. */
export const serializeRenderedMarkdown = (root: Element | DocumentFragment): string =>
  serializeNodes(Array.from(root.childNodes), '\n\n');

const getMarkdownRoot = (node: Node): Element | null => {
  const element = isElement(node) ? node : node.parentElement;
  return element?.closest(MARKDOWN_ROOT_SELECTOR) ?? null;
};

// Blocks that hold one piece of text. A selection that stays inside one of
// them is that text, not the list, table or emphasis around it.
const TEXT_BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, td, th, summary, dt, dd';

/**
 * The selected part of one rendered markdown block as Markdown, or null when
 * the range is not inside a single markdown root.
 *
 * Formatting inside the selection is kept. `cloneContents` drops the ancestors
 * the range starts and ends in, so a selection that crosses blocks is
 * re-nested in shallow copies of them: two list items stay a list, two table
 * cells stay a table. A selection within one text block (part of a list item,
 * a table cell, a bold run) is not re-nested and copies as the text itself.
 */
export const getMarkdownSelectionText = (range: Range): string | null => {
  const root = getMarkdownRoot(range.startContainer);
  if (!root || root !== getMarkdownRoot(range.endContainer)) return null;

  let content: Node = range.cloneContents();
  let ancestor: Node | null = range.commonAncestorContainer;
  if (ancestor.nodeType === TEXT_NODE) ancestor = ancestor.parentNode;
  const textBlock = ancestor && isElement(ancestor) ? ancestor.closest(TEXT_BLOCK_SELECTOR) : null;
  if (textBlock && root.contains(textBlock) && textBlock !== root) ancestor = null;
  while (ancestor && ancestor !== root && isElement(ancestor)) {
    const shell = ancestor.cloneNode(false);
    shell.appendChild(content);
    content = shell;
    ancestor = ancestor.parentNode;
  }

  const holder = root.ownerDocument.createElement('div');
  holder.appendChild(content);
  const markdown = serializeRenderedMarkdown(holder);
  return markdown.trim() ? markdown : null;
};
