/**
 * JSON Tree utilities for interactive JSON viewing.
 * Provides parsing, tree building, flattening, and path utilities.
 */

export type JsonTreeNodeType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonTreeNode {
  id: string;
  key: string;
  value: unknown;
  type: JsonTreeNodeType;
  depth: number;
  children?: JsonTreeNode[];
  path: string[];
  isExpandable: boolean;
  childCount?: number;
}

export interface FlatJsonNode {
  node: JsonTreeNode;
  isExpanded: boolean;
}

export interface JsonTreeOptions {
  maxDepth?: number;
  maxNodes?: number;
  initiallyExpandedDepth?: number;
}

const DEFAULT_OPTIONS: Required<JsonTreeOptions> = {
  maxDepth: 50,
  maxNodes: 100_000,
  initiallyExpandedDepth: 2,
};

function getType(value: unknown): JsonTreeNodeType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'null';
}

export function getNodePath(pathSegments: string[]): string {
  if (pathSegments.length === 0) return 'root';
  let result = 'root';
  for (const segment of pathSegments) {
    if (/^\d+$/.test(segment)) {
      result += `[${segment}]`;
    } else {
      result += `.${segment}`;
    }
  }
  return result;
}

export function parseNodePath(pathKey: string): string[] {
  if (pathKey === 'root' || pathKey === '') return [];
  const withoutRoot = pathKey.startsWith('root.') ? pathKey.slice(5) : pathKey.startsWith('root[') ? pathKey.slice(4) : pathKey;
  const segments: string[] = [];
  let current = '';
  let i = 0;
  while (i < withoutRoot.length) {
    const ch = withoutRoot[i];
    if (ch === '.') {
      if (current) segments.push(current);
      current = '';
      i++;
    } else if (ch === '[') {
      if (current) segments.push(current);
      current = '';
      i++;
      let bracket = '';
      while (i < withoutRoot.length && withoutRoot[i] !== ']') {
        bracket += withoutRoot[i];
        i++;
      }
      segments.push(bracket);
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  if (current) segments.push(current);
  return segments;
}

let nodeCount = 0;

function buildTreeNode(
  value: unknown,
  key: string,
  path: string[],
  depth: number,
  options: Required<JsonTreeOptions>,
): JsonTreeNode | null {
  if (nodeCount >= options.maxNodes) return null;
  nodeCount++;

  const type = getType(value);
  const id = getNodePath(path);
  const isExpandable = type === 'object' || type === 'array';

  const node: JsonTreeNode = {
    id,
    key,
    value,
    type,
    depth,
    path,
    isExpandable,
  };

  if (isExpandable && depth < options.maxDepth) {
    const entries = type === 'array'
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);

    node.childCount = entries.length;
    node.children = [];
    for (const [childKey, childValue] of entries) {
      const childPath = [...path, childKey];
      const child = buildTreeNode(childValue, childKey, childPath, depth + 1, options);
      if (child) node.children.push(child);
    }
  } else if (isExpandable) {
    node.childCount = type === 'array'
      ? (value as unknown[]).length
      : Object.keys(value as Record<string, unknown>).length;
  }

  return node;
}

export function parseJsonToTree(text: string, options?: JsonTreeOptions): JsonTreeNode | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  nodeCount = 0;

  try {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    return buildTreeNode(parsed, 'root', [], 0, opts);
  } catch {
    return null;
  }
}

export function flattenTree(root: JsonTreeNode | null, collapsedPaths: Set<string>): FlatJsonNode[] {
  if (!root) return [];

  const result: FlatJsonNode[] = [];

  function walk(node: JsonTreeNode) {
    const isExpanded = !collapsedPaths.has(node.id);
    result.push({ node, isExpanded });

    if (node.isExpandable && isExpanded && node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(root);
  return result;
}

export function getAllExpandableIds(root: JsonTreeNode | null): string[] {
  if (!root) return [];
  const ids: string[] = [];

  function walk(node: JsonTreeNode) {
    if (node.isExpandable) {
      ids.push(node.id);
      if (node.children) {
        for (const child of node.children) {
          walk(child);
        }
      }
    }
  }

  walk(root);
  return ids;
}

export function getExpandableIdsAboveDepth(root: JsonTreeNode | null, maxDepth: number): string[] {
  if (!root) return [];
  const ids: string[] = [];

  function walk(node: JsonTreeNode) {
    if (node.isExpandable && node.depth >= maxDepth) {
      ids.push(node.id);
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(root);
  return ids;
}

export function isJsonParseable(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
