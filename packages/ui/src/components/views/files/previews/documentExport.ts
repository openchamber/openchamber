import { strToU8 } from 'fflate';
import type { Nodes, Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { columnName } from '@/sync/document-attachments';
import { numericValue } from './tableCells';
import { packArchive, escapeXml } from './workbook/rezip';

const WORD_NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const parseMarkdown = (source: string): Root => unified().use(remarkParse).use(remarkGfm).parse(source);

const textOf = (node: Nodes): string => {
  if ('value' in node) return node.value;
  return 'children' in node ? node.children.map(textOf).join('') : '';
};

// ---- Word

type RunStyle = { bold?: boolean; italic?: boolean; code?: boolean };

const wordRun = (text: string, style: RunStyle): string => {
  const properties = [
    style.bold ? '<w:b/>' : '',
    style.italic ? '<w:i/>' : '',
    style.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '',
  ].join('');
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
};

const wordInline = (node: Nodes, style: RunStyle = {}): string => {
  switch (node.type) {
    case 'text':
    case 'html': return wordRun(node.value, style);
    case 'inlineCode': return wordRun(node.value, { ...style, code: true });
    case 'strong': return node.children.map((child) => wordInline(child, { ...style, bold: true })).join('');
    case 'emphasis': return node.children.map((child) => wordInline(child, { ...style, italic: true })).join('');
    case 'break': return '<w:r><w:br/></w:r>';
    default: return 'children' in node ? node.children.map((child) => wordInline(child, style)).join('') : '';
  }
};

const wordParagraph = (content: string, style?: string, indent = 0): string => {
  const properties = [style ? `<w:pStyle w:val="${style}"/>` : '', indent ? `<w:ind w:left="${indent * 360}"/>` : ''].join('');
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${content}</w:p>`;
};

const wordBlock = (node: RootContent, depth = 0): string => {
  switch (node.type) {
    case 'heading': return wordParagraph(node.children.map((child) => wordInline(child)).join(''), `Heading${node.depth}`);
    case 'paragraph': return wordParagraph(node.children.map((child) => wordInline(child)).join(''), undefined, depth);
    case 'code': return node.value.split('\n').map((line) => wordParagraph(wordRun(line, { code: true }), undefined, depth)).join('');
    case 'blockquote': return node.children.map((child) => wordBlock(child, depth + 1)).join('');
    case 'thematicBreak': return wordParagraph('');
    case 'list': return node.children.map((item, index) => {
      const marker = node.ordered ? `${(node.start ?? 1) + index}. ` : '• ';
      return item.children.map((child, childIndex) => {
        if (child.type === 'paragraph' && childIndex === 0) {
          return wordParagraph(`${wordRun(marker, {})}${child.children.map((inline) => wordInline(inline)).join('')}`, undefined, depth + 1);
        }
        return wordBlock(child, depth + 1);
      }).join('');
    }).join('');
    case 'table': {
      const rows = node.children.map((row) => `<w:tr>${row.children.map((cell) => `<w:tc><w:p>${cell.children.map((child) => wordInline(child)).join('')}</w:p></w:tc>`).join('')}</w:tr>`).join('');
      const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="999999"/>`).join('');
      return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${rows}</w:tbl>${wordParagraph('')}`;
    }
    default: return wordParagraph(wordRun(textOf(node), {}));
  }
};

const headingStyles = [1, 2, 3, 4, 5, 6].map((level) => (
  `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:rPr><w:b/><w:sz w:val="${36 - level * 3}"/></w:rPr></w:style>`
)).join('');

export const markdownToDocx = (source: string): Promise<Uint8Array<ArrayBuffer>> => {
  const body = parseMarkdown(source).children.map((node) => wordBlock(node)).join('');
  return packArchive({
    '[Content_Types].xml': strToU8(`${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/styles" Target="styles.xml"/></Relationships>`),
    'word/styles.xml': strToU8(`${XML_HEADER}<w:styles ${WORD_NAMESPACE}>${headingStyles}</w:styles>`),
    'word/document.xml': strToU8(`${XML_HEADER}<w:document ${WORD_NAMESPACE}><w:body>${body}<w:sectPr/></w:body></w:document>`),
  });
};

// ---- Printable page

const htmlInline = (node: Nodes): string => {
  const inner = () => ('children' in node ? node.children.map(htmlInline).join('') : '');
  switch (node.type) {
    case 'text':
    case 'html': return escapeXml(node.value);
    case 'inlineCode': return `<code>${escapeXml(node.value)}</code>`;
    case 'strong': return `<strong>${inner()}</strong>`;
    case 'emphasis': return `<em>${inner()}</em>`;
    case 'delete': return `<s>${inner()}</s>`;
    case 'break': return '<br>';
    case 'link': return `<a href="${escapeXml(node.url)}">${inner()}</a>`;
    default: return inner();
  }
};

const htmlBlock = (node: RootContent): string => {
  switch (node.type) {
    case 'heading': return `<h${node.depth}>${node.children.map(htmlInline).join('')}</h${node.depth}>`;
    case 'paragraph': return `<p>${node.children.map(htmlInline).join('')}</p>`;
    case 'code': return `<pre><code>${escapeXml(node.value)}</code></pre>`;
    case 'blockquote': return `<blockquote>${node.children.map(htmlBlock).join('')}</blockquote>`;
    case 'thematicBreak': return '<hr>';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      return `<${tag}>${node.children.map((item) => `<li>${item.children.map(htmlBlock).join('')}</li>`).join('')}</${tag}>`;
    }
    case 'table': return `<table>${node.children.map((row, index) => `<tr>${row.children.map((cell) => {
      const tag = index === 0 ? 'th' : 'td';
      return `<${tag}>${cell.children.map(htmlInline).join('')}</${tag}>`;
    }).join('')}</tr>`).join('')}</table>`;
    default: return escapeXml(textOf(node));
  }
};

const PRINT_STYLE = `
body { font: 11pt/1.5 system-ui, sans-serif; color: #111; margin: 0; }
pre, code { font-family: ui-monospace, monospace; font-size: 10pt; }
pre { background: #f4f4f4; padding: 8px; white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #999; padding: 4px 8px; text-align: start; }
blockquote { border-inline-start: 3px solid #bbb; margin-inline: 0; padding-inline-start: 12px; }
`;

export const markdownToPrintableHtml = (source: string, title: string): string => (
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>${PRINT_STYLE}</style></head><body>${parseMarkdown(source).children.map(htmlBlock).join('')}</body></html>`
);

/** The system print dialog, where Save as PDF lives. The page stays in a hidden frame of this app. */
export const printHtml = (html: string): void => {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.addEventListener('afterprint', () => frame.remove());
    frame.contentWindow?.print();
  };
  document.body.append(frame);
};

// ---- Spreadsheet

export const rowsToXlsx = (sheetName: string, rows: string[][]): Promise<Uint8Array<ArrayBuffer>> => {
  const sheet = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, column) => {
    const reference = `${columnName(column)}${rowIndex + 1}`;
    if (value === '') return '';
    const plain = /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()) && numericValue(value) !== null;
    return plain ? `<c r="${reference}"><v>${value.trim()}</v></c>` : `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return packArchive({
    '[Content_Types].xml': strToU8(`${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    '_rels/.rels': strToU8(`${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/_rels/workbook.xml.rels': strToU8(`${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`${XML_HEADER}<workbook xmlns="${main}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets><sheet name="${escapeXml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/worksheets/sheet1.xml': strToU8(`${XML_HEADER}<worksheet xmlns="${main}"><sheetData>${sheet}</sheetData></worksheet>`),
  });
};
