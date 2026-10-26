import { isMap, isScalar, isSeq, parseDocument, stringify, type Node } from 'yaml';

export type FrontmatterValue =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  /** Nested mappings and lists of mappings, shown as the YAML they are. */
  | { kind: 'code'; text: string };

export type FrontmatterProperty = { key: string; value: FrontmatterValue };

export type Frontmatter =
  | { kind: 'properties'; properties: FrontmatterProperty[] }
  /** TOML, invalid YAML, or YAML that is not a mapping: shown as written. */
  | { kind: 'raw'; text: string };

const FRONTMATTER_PATTERN = /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\1[^\S\r\n]*(?:\r?\n|$)/;

const scalarText = (node: Node): string => (
  isScalar(node) ? String(node.value ?? '') : stringify(node).trimEnd()
);

const toValue = (node: Node | null): FrontmatterValue => {
  if (!node) return { kind: 'text', text: '' };
  if (isScalar(node)) return { kind: 'text', text: scalarText(node) };
  if (isSeq(node) && node.items.every((item) => isScalar(item))) {
    return { kind: 'list', items: node.items.map((item) => scalarText(item)) };
  }
  return { kind: 'code', text: stringify(node).trimEnd() };
};

const parseFrontmatter = (delimiter: string, text: string): Frontmatter | null => {
  if (delimiter !== '---') return { kind: 'raw', text };
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { kind: 'raw', text };
  if (doc.contents === null) return null;
  if (!isMap(doc.contents)) return { kind: 'raw', text };
  return {
    kind: 'properties',
    properties: doc.contents.items.map((pair) => ({
      key: pair.key ? scalarText(pair.key) : '',
      value: toValue(pair.value),
    })),
  };
};

type SplitDocument = { frontmatter: Frontmatter | null; body: string };

/** Splits a document's leading YAML (`---`) or TOML (`+++`) block from its body. */
export const splitFrontmatter = (markdown: string): SplitDocument => {
  const match = markdown.match(FRONTMATTER_PATTERN);
  if (!match) return { frontmatter: null, body: markdown };
  return {
    frontmatter: parseFrontmatter(match[1], match[2]),
    body: markdown.slice(match[0].length),
  };
};
