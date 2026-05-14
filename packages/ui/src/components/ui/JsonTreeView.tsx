import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { JsonTreeViewer } from './JsonTreeViewer';
import { useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();
  const viewerRef = React.useRef<{ expandAll: () => void; collapseAll: () => void }>(null);
  const [parseError, setParseError] = React.useState<string | null>(null);

  const parsedData = React.useMemo(() => {
    try {
      const trimmed = jsonString.trim();
      if (!trimmed) {
        setParseError(t('jsonTreeView.error.emptyJson'));
        return null;
      }
      const parsed = JSON.parse(trimmed);
      setParseError(null);
      return parsed;
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t('jsonTreeView.error.invalidJson'));
      return null;
    }
  }, [jsonString, t]);

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
          <div className="mb-1 font-medium text-[var(--surface-foreground)]">{t('jsonTreeView.error.invalidJsonTitle')}</div>
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
          <Icon name="arrow-down-s" className="h-3 w-3" />
          {t('jsonTreeView.actions.expandAll')}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleCollapseAll}
          className="gap-1 text-xs text-muted-foreground"
        >
          <Icon name="arrow-up-s" className="h-3 w-3" />
          {t('jsonTreeView.actions.collapseAll')}
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
