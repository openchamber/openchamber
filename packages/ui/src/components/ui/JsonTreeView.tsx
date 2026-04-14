import React from 'react';
import { RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { JsonTreeViewer } from './JsonTreeViewer';
import {
  jsonEmptyContent,
  jsonInvalid,
  jsonExpandAll,
  jsonCollapseAll,
} from '@/lib/i18n/messages';

interface JsonTreeViewProps {
  jsonString: string;
  className?: string;
  maxHeight?: string;
  initiallyExpandedDepth?: number;
}

const JsonTreeView = React.memo(function JsonTreeView({
  jsonString,
  className,
  maxHeight = '100%',
  initiallyExpandedDepth = 2,
}: JsonTreeViewProps) {
  const viewerRef = React.useRef<{ expandAll: () => void; collapseAll: () => void }>(null);
  const [parseError, setParseError] = React.useState<string | null>(null);

  const parsedData = React.useMemo(() => {
    try {
      const trimmed = jsonString.trim();
      if (!trimmed) {
        setParseError(jsonEmptyContent());
        return null;
      }
      const parsed = JSON.parse(trimmed);
      setParseError(null);
      return parsed;
    } catch (err) {
      setParseError(err instanceof Error ? err.message : jsonInvalid());
      return null;
    }
  }, [jsonString]);

  const handleExpandAll = React.useCallback(() => {
    viewerRef.current?.expandAll();
  }, []);

  const handleCollapseAll = React.useCallback(() => {
    viewerRef.current?.collapseAll();
  }, []);

  if (parseError) {
    return (
      <div className={className}>
        <div className="rounded-md border border-[var(--interactive-border)] bg-[var(--syntax-base-background)] p-4">
          <div className="mb-1 font-medium text-[var(--surface-foreground)]">{jsonInvalid()}</div>
          <div className="font-mono text-xs text-[var(--surface-mutedForeground)]">{parseError}</div>
        </div>
      </div>
    );
  }

  if (parsedData === null) {
    return null;
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-1 border-b border-[var(--interactive-border)] px-2 py-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={handleExpandAll}
          className="gap-1 text-xs text-muted-foreground"
        >
          <RiArrowDownSLine className="h-3 w-3" />
          {jsonExpandAll()}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleCollapseAll}
          className="gap-1 text-xs text-muted-foreground"
        >
          <RiArrowUpSLine className="h-3 w-3" />
          {jsonCollapseAll()}
        </Button>
      </div>
      <div
        className="bg-[var(--syntax-base-background)] py-1"
        style={{ maxHeight, overflow: 'auto' }}
      >
        <JsonTreeViewer
          ref={viewerRef}
          data={parsedData}
          maxHeight={maxHeight}
          initiallyExpandedDepth={initiallyExpandedDepth}
        />
      </div>
    </div>
  );
});

export { JsonTreeView };
export type { JsonTreeViewProps };
