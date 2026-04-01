import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine } from '@remixicon/react';
import { useVirtualizer } from '@tanstack/react-virtual';

import {
  parseJsonToTree,
  flattenTree,
  getAllExpandableIds,
  getExpandableIdsAboveDepth,
  type JsonTreeNode,
  type FlatJsonNode,
} from '@/lib/jsonTreeUtils';

interface JsonTreeViewerProps {
  data: unknown;
  className?: string;
  maxHeight?: string;
  initiallyExpandedDepth?: number;
  onCopyPath?: (path: string) => void;
}

const RAINBOW_COLORS = [
  'var(--syntax-key)',
  'color-mix(in oklch, var(--syntax-key) 85%, var(--syntax-string))',
  'color-mix(in oklch, var(--syntax-key) 70%, var(--syntax-number))',
  'color-mix(in oklch, var(--syntax-key) 55%, var(--syntax-function))',
  'color-mix(in oklch, var(--syntax-key) 40%, var(--syntax-type))',
  'color-mix(in oklch, var(--syntax-key) 30%, var(--syntax-keyword))',
];

function getKeyColor(depth: number): string {
  return RAINBOW_COLORS[depth % RAINBOW_COLORS.length];
}

function getValueColor(node: JsonTreeNode): string {
  switch (node.type) {
    case 'string':
      return 'var(--syntax-string)';
    case 'number':
      return 'var(--syntax-number)';
    case 'boolean':
      return 'var(--syntax-keyword)';
    case 'null':
      return 'var(--syntax-comment)';
    default:
      return 'var(--surface-foreground)';
  }
}

function formatValuePreview(node: JsonTreeNode): string {
  switch (node.type) {
    case 'string': {
      const str = node.value as string;
      if (str.length > 60) return `"${str.slice(0, 57)}..."`;
      return `"${str}"`;
    }
    case 'number':
    case 'boolean':
      return String(node.value);
    case 'null':
      return 'null';
    case 'object':
      return `{${node.childCount ?? 0} ${node.childCount === 1 ? 'item' : 'items'}}`;
    case 'array':
      return `[${node.childCount ?? 0}]`;
    default:
      return String(node.value);
  }
}

function getCollapsedPreview(node: JsonTreeNode): string {
  if (node.type === 'object') {
    const keys = node.children?.map((c) => c.key).slice(0, 3) ?? [];
    const suffix = (node.childCount ?? 0) > 3 ? ', ...' : '';
    return `{ ${keys.map((k) => `"${k}": ...`).join(', ')}${suffix} }`;
  }
  if (node.type === 'array') {
    const count = node.childCount ?? 0;
    if (count <= 3) {
      const items = node.children?.map((c) => formatValuePreview(c)).join(', ') ?? '';
      return `[${items}]`;
    }
    return `[${count} items]`;
  }
  return formatValuePreview(node);
}

const JsonRow = React.memo(
  ({
    flatNode,
    onToggle,
    onCopyPath,
  }: {
    flatNode: FlatJsonNode;
    onToggle: (id: string) => void;
    onCopyPath?: (path: string) => void;
  }) => {
    const { node, isExpanded } = flatNode;
    const indent = node.depth * 20;

    const handleToggle = React.useCallback(() => {
      onToggle(node.id);
    }, [onToggle, node.id]);

    const handleContextMenu = React.useCallback(
      (e: React.MouseEvent) => {
        if (onCopyPath) {
          e.preventDefault();
          onCopyPath(node.id);
        }
      },
      [onCopyPath, node.id],
    );

    const keyColor = getKeyColor(node.depth);
    const valueColor = getValueColor(node);
    const isCollapsible = node.isExpandable && node.children && node.children.length > 0;

    return (
      <div
        className="flex items-center py-0.5 px-2 hover:bg-[var(--surface-hover)] rounded-sm cursor-default font-mono text-xs leading-5 whitespace-nowrap"
        style={{ paddingLeft: `${indent + 8}px` }}
        onContextMenu={handleContextMenu}
      >
        {isCollapsible ? (
          <button
            type="button"
            onClick={handleToggle}
            className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm hover:bg-[var(--interactive-hover)] text-muted-foreground"
          >
            {isExpanded ? (
              <RiArrowDownSLine className="h-3 w-3" />
            ) : (
              <RiArrowRightSLine className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="mr-1 w-4" />
        )}

        {node.key !== 'root' && (
          <>
            <span
              className="mr-1 font-semibold"
              style={{ color: keyColor }}
            >
              {/^\d+$/.test(node.key) ? node.key : `"${node.key}"`}
            </span>
            <span className="mr-1 text-[var(--surface-foreground)]">:</span>
          </>
        )}

        {node.isExpandable ? (
          isExpanded ? (
            <span className="text-[var(--surface-foreground)]">
              {node.type === 'object' ? '{' : '['}
            </span>
          ) : (
            <span style={{ color: 'var(--surface-mutedForeground)' }}>
              {getCollapsedPreview(node)}
            </span>
          )
        ) : (
          <span style={{ color: valueColor }}>{formatValuePreview(node)}</span>
        )}
      </div>
    );
  },
);

JsonRow.displayName = 'JsonRow';

const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT = 22;

const JsonTreeViewer = React.forwardRef<{ expandAll: () => void; collapseAll: () => void }, JsonTreeViewerProps>(
  function JsonTreeViewer(
    { data, className, maxHeight = '100%', initiallyExpandedDepth = 2, onCopyPath },
    ref,
  ) {
    const jsonString = React.useMemo(() => {
      try {
        return JSON.stringify(data);
      } catch {
        return null;
      }
    }, [data]);

    const treeRoot = React.useMemo(() => {
      if (!jsonString) return null;
      return parseJsonToTree(jsonString);
    }, [jsonString]);

    const [collapsedPaths, setCollapsedPaths] = React.useState<Set<string>>(() => {
      if (!treeRoot) return new Set();
      return new Set(getExpandableIdsAboveDepth(treeRoot, initiallyExpandedDepth));
    });

    const flatNodes = React.useMemo(
      () => flattenTree(treeRoot, collapsedPaths),
      [treeRoot, collapsedPaths],
    );

    const shouldVirtualize = flatNodes.length > VIRTUALIZE_THRESHOLD;
    const parentRef = React.useRef<HTMLDivElement>(null);

    const virtualizer = useVirtualizer({
      count: flatNodes.length,
      getScrollElement: () => parentRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 20,
      enabled: shouldVirtualize,
    });

    const handleToggle = React.useCallback((id: string) => {
      setCollapsedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    }, []);

    const expandAll = React.useCallback(() => {
      setCollapsedPaths(new Set());
    }, []);

    const collapseAll = React.useCallback(() => {
      if (!treeRoot) return;
      setCollapsedPaths(new Set(getAllExpandableIds(treeRoot)));
    }, [treeRoot]);

    React.useImperativeHandle(ref, () => ({ expandAll, collapseAll }), [expandAll, collapseAll]);

    if (!treeRoot) {
      return null;
    }

    if (shouldVirtualize) {
      return (
        <div
          ref={parentRef}
          className={className}
          style={{ maxHeight, overflow: 'auto' }}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const flatNode = flatNodes[virtualRow.index];
              if (!flatNode) return null;
              return (
                <div
                  key={flatNode.node.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <JsonRow
                    flatNode={flatNode}
                    onToggle={handleToggle}
                    onCopyPath={onCopyPath}
                  />
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    return (
      <div
        ref={parentRef}
        className={className}
        style={{ maxHeight, overflow: 'auto' }}
      >
        {flatNodes.map((flatNode) => (
          <JsonRow
            key={flatNode.node.id}
            flatNode={flatNode}
            onToggle={handleToggle}
            onCopyPath={onCopyPath}
          />
        ))}
      </div>
    );
  },
);

export { JsonTreeViewer };
export type { JsonTreeViewerProps };
