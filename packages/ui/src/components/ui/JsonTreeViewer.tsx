import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import {
  parseJsonToTree,
  flattenTree,
  getAllExpandableIds,
  getExpandableIdsAboveDepth,
  type JsonTreeNode,
  type FlatJsonNode,
} from '@/lib/jsonTreeUtils';
import { Icon } from '@/components/icon/Icon';
import { FileTreeIndentGuides } from '@/components/views/files/FileTreeRowParts';
import { fileTreeRowPaddingLeft } from '@/components/views/files/fileTreeRow';
import { cn } from '@/lib/utils';

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

function JsonRowValue({ node, isExpanded, isCollapsible }: { node: JsonTreeNode; isExpanded: boolean; isCollapsible: boolean }) {
  if (!node.isExpandable) {
    return <span style={{ color: getValueColor(node) }}>{formatValuePreview(node)}</span>;
  }
  const brackets = node.type === 'object' ? '{}' : '[]';
  if (!isCollapsible) {
    // Empty, or past maxDepth/maxNodes: its children were never read, so show its size.
    if (node.childCount === 0) {
      return <span className="text-[var(--syntax-foreground)]">{brackets}</span>;
    }
    return <span className="text-muted-foreground">{formatValuePreview(node)}</span>;
  }
  if (isExpanded) {
    return <span className="text-[var(--syntax-foreground)]">{brackets[0]}</span>;
  }
  return <span className="text-muted-foreground">{getCollapsedPreview(node)}</span>;
}

// Rows share the file tree's geometry and look (FILE_TREE_INDENT_PX per level,
// one guide per ancestor under its chevron), so nesting reads the same in both trees.
const ROW_CLASS_NAME = 'relative flex items-center rounded-sm py-0.5 pe-2 cursor-default font-mono text-xs leading-5 whitespace-nowrap';

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
    const { node } = flatNode;
    const isExpanded = flatNode.kind === 'node' && flatNode.isExpanded;

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

    const rowStyle = { paddingInlineStart: fileTreeRowPaddingLeft(node.depth) };
    const closeBracket = node.type === 'object' ? '}' : ']';
    const spacer = <span aria-hidden className="me-1 w-3.5 shrink-0" />;

    if (flatNode.kind === 'close') {
      return (
        <div className={ROW_CLASS_NAME} style={rowStyle}>
          <FileTreeIndentGuides depth={node.depth} />
          {spacer}
          <span className="text-[var(--syntax-foreground)]">{closeBracket}</span>
        </div>
      );
    }

    const keyColor = getKeyColor(node.depth);
    const isCollapsible = (node.children?.length ?? 0) > 0;

    return (
      <div
        className={ROW_CLASS_NAME}
        style={rowStyle}
        onContextMenu={handleContextMenu}
      >
        <FileTreeIndentGuides depth={node.depth} />
        {isCollapsible ? (
          <button
            type="button"
            onClick={handleToggle}
            aria-expanded={isExpanded}
            // The arrow stays as small as the line, so the row keeps its height on
            // touch screens too: the inline mins beat mobile.css's 36px button
            // floor, and the invisible ::before widens the tap area to the row's
            // full height and into the indent: 26x24px, under that floor on
            // purpose, because a 36px arrow made its row taller than its siblings.
            className="relative me-1 flex w-3.5 shrink-0 items-center justify-center self-stretch rounded-sm hover:bg-interactive-hover before:absolute before:-inset-y-0.5 before:-inset-s-2 before:-inset-e-1 before:content-['']"
            style={{ minHeight: 0, minWidth: 0 }}
          >
            {/* FileTreeChevron's look without its rtl: rotation: Tailwind's rtl:
                variant follows <html dir>, but this tree is dir="ltr", where the
                icon is not mirrored, so that rotation would point it up. */}
            <Icon
              name="arrow-right-s"
              className={cn('size-3.5 text-muted-foreground transition-transform', isExpanded && 'rotate-90')}
            />
          </button>
        ) : spacer}

        {node.key !== 'root' && (
          <>
            <span
              className="me-1 font-semibold"
              style={{ color: keyColor }}
            >
              {/^\d+$/.test(node.key) ? node.key : `"${node.key}"`}
            </span>
            <span className="me-1 text-[var(--syntax-foreground)]">:</span>
          </>
        )}

        <JsonRowValue node={node} isExpanded={isExpanded} isCollapsible={isCollapsible} />
      </div>
    );
  },
);

JsonRow.displayName = 'JsonRow';

const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT = 24;

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
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: flatNodes.length,
      enabled: shouldVirtualize,
      getScrollElement: () => parentRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 20,
      getItemKey: (index) => flatNodes[index]?.key ?? index,
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

    // JSON is code: it reads left to right in every language (rtl-layout), so
    // brackets are not mirrored and "</head>" does not turn into "<head/>".

    if (shouldVirtualize) {
      return (
        <div
          ref={parentRef}
          dir="ltr"
          className={className}
          style={{ maxHeight, overflow: 'auto' }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const flatNode = flatNodes[item.index];
              if (!flatNode) return null;
              return (
                <div
                  key={flatNode.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
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
        dir="ltr"
        className={className}
        style={{ maxHeight, overflow: 'auto' }}
      >
        {flatNodes.map((flatNode) => (
          <JsonRow
            key={flatNode.key}
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
