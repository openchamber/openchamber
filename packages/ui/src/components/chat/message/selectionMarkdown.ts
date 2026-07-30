type SelectionNode =
  | { type: 'text'; value: string }
  | {
      type: 'element';
      tag: string;
      className: string;
      href: string;
      component: string;
      markdownLanguage: string;
      isMarkdownBlock: boolean;
      isCodeLines: boolean;
      isCodeLineNumber: boolean;
      children: SelectionNode[];
    };

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul',
]);

const normalizeLineBreaks = (value: string): string => value.replace(/\r\n?/g, '\n');
export const trimSelectionValue = (value: string): string => normalizeLineBreaks(value).trim();
const textToMarkdownInline = (value: string): string => value.replace(/\s+/g, ' ').trim();

const getCodeLanguageFromClassName = (className: string): string => {
  return (className.match(/language-([\w+#.-]+)/)?.[1] || '').trim();
};

const getBlockCodeLanguage = (code: HTMLElement): string => {
  return code.closest('pre')?.getAttribute('data-md-lang')
    || getCodeLanguageFromClassName(code.className);
};

const toSelectionNode = (node: Node): SelectionNode | null => {
  if (node.nodeType === 3) {
    return { type: 'text', value: node.textContent || '' };
  }
  if (node.nodeType !== 1) {
    return null;
  }

  const element = node as Element;
  return {
    type: 'element',
    tag: element.tagName.toLowerCase(),
    className: element.getAttribute('class') || '',
    href: element.getAttribute('href') || '',
    component: element.getAttribute('data-component') || '',
    markdownLanguage: element.getAttribute('data-md-lang') || '',
    isMarkdownBlock: element.hasAttribute('data-md-block'),
    isCodeLines: element.hasAttribute('data-md-code-lines'),
    isCodeLineNumber: element.hasAttribute('data-md-code-line-number'),
    children: Array.from(element.childNodes)
      .map((child) => toSelectionNode(child))
      .filter((child): child is SelectionNode => child !== null),
  };
};

export const trimSelectionNodes = (nodes: SelectionNode[]): SelectionNode[] => {
  return nodes
    .filter((node) => node.type === 'text' || !node.isCodeLineNumber)
    .map((node) => node.type === 'text'
      ? node
      : { ...node, children: trimSelectionNodes(node.children) });
};

const toSelectionNodes = (root: ParentNode): SelectionNode[] => {
  return Array.from(root.childNodes)
    .map((child) => toSelectionNode(child))
    .filter((child): child is SelectionNode => child !== null);
};

const getSelectionText = (node: SelectionNode): string => {
  return node.type === 'text'
    ? node.value
    : node.children.map((child) => getSelectionText(child)).join('');
};

const findElement = (
  node: SelectionNode,
  predicate: (element: Extract<SelectionNode, { type: 'element' }>) => boolean,
): Extract<SelectionNode, { type: 'element' }> | null => {
  if (node.type === 'text') return null;
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
};

export const formatCodeSelectionMarkdown = (code: string, language = ''): string => {
  const normalizedCode = normalizeLineBreaks(code).replace(/\n$/, '');
  const longestBacktickRun = Math.max(0, ...Array.from(normalizedCode.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${normalizedCode}\n${fence}`;
};

const renderInlineMarkdownNode = (node: SelectionNode): string => {
  if (node.type === 'text') {
    return textToMarkdownInline(node.value);
  }

  const childText = node.children
    .map((child) => renderInlineMarkdownNode(child))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (!childText && node.tag !== 'br') return '';
  if (node.tag === 'br') return '\n';
  if (node.tag === 'strong' || node.tag === 'b') return `**${childText}**`;
  if (node.tag === 'em' || node.tag === 'i') return `*${childText}*`;
  if (node.tag === 'code') return `\`${childText.replace(/`/g, '\\`')}\``;
  if (node.tag === 'a') return node.href ? `[${childText}](${node.href})` : childText;
  return childText;
};

const renderListMarkdown = (list: Extract<SelectionNode, { type: 'element' }>, ordered: boolean): string => {
  return list.children
    .filter((child): child is Extract<SelectionNode, { type: 'element' }> => child.type === 'element' && child.tag === 'li')
    .map((item, index) => {
      const body = item.children
        .map((child) => renderInlineMarkdownNode(child))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      return body ? `${ordered ? `${index + 1}.` : '-'} ${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
};

const renderBlockMarkdownNode = (node: SelectionNode): string => {
  if (node.type === 'text') return trimSelectionValue(node.value);

  if (node.isMarkdownBlock) {
    return node.children
      .map((child) => renderBlockMarkdownNode(child))
      .filter((child) => child.length > 0)
      .join('\n\n');
  }

  if (node.component === 'markdown-code') {
    const pre = findElement(node, (element) => element.tag === 'pre');
    return pre ? renderBlockMarkdownNode(pre) : '';
  }

  if (node.tag === 'pre' || (node.tag === 'code' && node.isCodeLines)) {
    const code = node.tag === 'code'
      ? node
      : findElement(node, (element) => element.tag === 'code');
    return formatCodeSelectionMarkdown(
      code ? getSelectionText(code) : getSelectionText(node),
      node.markdownLanguage || getCodeLanguageFromClassName(code?.className || ''),
    );
  }

  if (node.tag === 'code') {
    const code = normalizeLineBreaks(getSelectionText(node)).trim();
    return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
  }
  if (node.tag === 'ul') return renderListMarkdown(node, false);
  if (node.tag === 'ol') return renderListMarkdown(node, true);

  if (node.tag === 'blockquote') {
    const content = trimSelectionValue(node.children.map((child) => renderBlockMarkdownNode(child)).join('\n'));
    return content
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `> ${line}`)
      .join('\n');
  }

  if (/^h[1-6]$/.test(node.tag)) {
    const level = Number.parseInt(node.tag[1], 10);
    const text = trimSelectionValue(node.children.map((child) => renderInlineMarkdownNode(child)).join(''));
    return text ? `${'#'.repeat(level)} ${text}` : '';
  }

  if (node.tag === 'p' || node.tag === 'div' || node.tag === 'li') {
    return trimSelectionValue(node.children.map((child) => renderInlineMarkdownNode(child)).join(''));
  }

  const blockChildren = node.children
    .map((child) => renderBlockMarkdownNode(child))
    .filter((child) => child.length > 0);
  return blockChildren.length > 0
    ? blockChildren.join('\n\n')
    : trimSelectionValue(node.children.map((child) => renderInlineMarkdownNode(child)).join(''));
};

const isInlineSelectionNode = (node: SelectionNode): boolean => {
  if (node.type === 'text') return true;
  return !node.isMarkdownBlock && !node.isCodeLines && node.component !== 'markdown-code' && !BLOCK_TAGS.has(node.tag);
};

export const selectionNodesToMarkdown = (nodes: SelectionNode[], plainText: string): string => {
  const trimmedNodes = trimSelectionNodes(nodes);
  if (trimmedNodes.every((node) => isInlineSelectionNode(node))) {
    const inlineMarkdown = trimSelectionValue(trimmedNodes.map((node) => renderInlineMarkdownNode(node)).join(''));
    if (inlineMarkdown) return inlineMarkdown;
  }

  const markdown = trimmedNodes
    .map((node) => renderBlockMarkdownNode(node))
    .filter((value) => value.length > 0)
    .join('\n\n')
    .trim();
  return markdown || trimSelectionValue(plainText);
};

const getContainingBlockCode = (node: Node): HTMLElement | null => {
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return element?.closest<HTMLElement>('pre code') ?? null;
};

export const rangeToMarkdown = (range: Range, plainText: string): string => {
  const startCode = getContainingBlockCode(range.startContainer);
  const endCode = getContainingBlockCode(range.endContainer);
  const nodes = trimSelectionNodes(toSelectionNodes(range.cloneContents()));

  if (startCode && startCode === endCode) {
    return formatCodeSelectionMarkdown(
      nodes.map((node) => getSelectionText(node)).join(''),
      getBlockCodeLanguage(startCode),
    );
  }

  return selectionNodesToMarkdown(nodes, plainText);
};

export const wrapMarkdownSelectionForChat = (markdown: string): string => {
  const longestBacktickRun = Math.max(0, ...Array.from(markdown.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}md\n${markdown}\n${fence}`;
};
