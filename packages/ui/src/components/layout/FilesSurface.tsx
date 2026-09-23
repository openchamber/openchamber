import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { clampContextEditorTreeWidth, useUIStore } from '@/stores/useUIStore';
import { SidebarFilesTree } from './SidebarFilesTree';
import { TabCloseMenuItems } from './TabCloseMenuItems';
import { FilesEditorSlot } from './workspace/FilesEditorHost';
import { useGuardFileLeave } from './workspace/filesEditorWorkspace';

// The editor surface's file-tree column: docked on the right, resizable from
// its left edge, and animated open/closed like the app sidebars. In tree-only
// mode (`fill`), the panel collapses around this fixed-width, right-aligned column.
const EditorTreeColumn: React.FC<{ visible: boolean; active: boolean; fill?: boolean }> = ({ visible, active, fill = false }) => {
  const { t } = useI18n();
  const width = useUIStore((state) => state.contextEditorTreeWidth);
  const setWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);

  const applyLiveTreeWidth = React.useCallback((nextWidth: number) => {
    const column = columnRef.current;
    if (!column) {
      return;
    }
    column.style.width = `${nextWidth}px`;
    column.style.setProperty('--oc-editor-tree-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!visible) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || pointerIDRef.current !== event.pointerId) {
      return;
    }
    const delta = startXRef.current - event.clientX;
    const nextWidth = clampContextEditorTreeWidth(startWidthRef.current + delta);
    if (liveWidthRef.current === nextWidth) {
      return;
    }
    liveWidthRef.current = nextWidth;
    applyLiveTreeWidth(nextWidth);
  };

  const handlePointerEnd = (event: React.PointerEvent) => {
    if (pointerIDRef.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampContextEditorTreeWidth(liveWidthRef.current ?? width);
    pointerIDRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
  };

  const appliedWidth = visible ? width : 0;
  const columnStyle: React.CSSProperties & { '--oc-editor-tree-width': string } = {
    width: `${isResizing ? (liveWidthRef.current ?? appliedWidth) : appliedWidth}px`,
    maxWidth: fill ? '100%' : undefined,
    '--oc-editor-tree-width': `${isResizing ? (liveWidthRef.current ?? width) : width}px`,
    overflowX: 'clip',
    transitionProperty: isResizing ? 'none' : 'width',
    transitionDuration: '200ms',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  };

  return (
    <div
      ref={columnRef}
      className={cn(
        'relative h-full flex-shrink-0 overflow-hidden bg-background will-change-[width] motion-reduce:transition-none',
        fill && 'ml-auto',
      )}
      style={columnStyle}
      aria-hidden={!visible}
    >
      {/* Paint the divider without shifting tree content when the editor closes. */}
      {visible && !fill && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-20 w-px bg-border" />
      )}
      {visible && !fill && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        className={cn(
          'relative z-10 h-full shrink-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          isResizing && 'pointer-events-none',
          !visible && 'pointer-events-none select-none opacity-0'
        )}
        style={{ width: 'var(--oc-editor-tree-width)', maxWidth: fill ? '100%' : undefined }}
        aria-hidden={!visible}
      >
        <SidebarFilesTree visible={visible && active} />
      </div>
    </div>
  );
};

type FilesSurfaceProps = {
  directoryKey: string;
  /** This zone's open files; the explorer placeholder is Files with none. */
  fileTabItems: SortableTabsStripItem[];
  /** The file the editor shows, while Files is what the zone shows. */
  activeFile: { id: string; path: string } | null;
  /** Files is what the zone shows. */
  shown: boolean;
  /** The zone is open (not collapsed). */
  zoneOpen: boolean;
  hasOpenFile: boolean;
  showsEditor: boolean;
  treeVisible: boolean;
  /** The zone's key handling, for the editor drawn by FilesEditorHost. */
  onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => void;
};

/**
 * The inside of the Files workspace surface: its own strip of open files, the
 * editor slot and the file tree. The zone's strip lists Files once; files are
 * content here, so their menu only closes files and carries no placement.
 */
export const FilesSurface: React.FC<FilesSurfaceProps> = ({
  directoryKey,
  fileTabItems,
  activeFile,
  shown,
  zoneOpen,
  hasOpenFile,
  showsEditor,
  treeVisible,
  onKeyDownCapture,
}) => {
  const { t } = useI18n();
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const closeContextPanelTabs = useUIStore((state) => state.closeContextPanelTabs);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const guardFileLeave = useGuardFileLeave();

  // Leaving the file in the editor, for another file or by closing it, goes
  // through the editor's own save-or-discard check first.
  const selectFile = React.useCallback((id: string) => {
    const select = () => setActiveContextPanelTab(directoryKey, id);
    if (activeFile && id !== activeFile.id) guardFileLeave(activeFile.path, select);
    else select();
  }, [activeFile, directoryKey, guardFileLeave, setActiveContextPanelTab]);
  const closeFiles = React.useCallback((ids: readonly string[]) => {
    const close = () => closeContextPanelTabs(directoryKey, ids);
    if (activeFile && ids.includes(activeFile.id)) guardFileLeave(activeFile.path, close);
    else close();
  }, [activeFile, closeContextPanelTabs, directoryKey, guardFileLeave]);
  const renderFileTabContextMenu = React.useCallback(
    (args: { id: string; index: number; allIds: string[]; close: () => void }): React.ReactNode => (
      <TabCloseMenuItems {...args} closeIds={closeFiles} />
    ),
    [closeFiles],
  );

  return (
    <div className={cn('absolute inset-0 flex-col', shown ? 'flex' : 'hidden')}>
      {fileTabItems.length > 0 ? (
        <div className="flex h-9 shrink-0 items-stretch border-b border-border">
          <SortableTabsStrip
            items={fileTabItems}
            activeId={activeFile?.id ?? null}
            onSelect={selectFile}
            onClose={(tabID) => closeFiles([tabID])}
            onReorder={(activeTabID, overTabID) => reorderContextPanelTabs(directoryKey, activeTabID, overTabID)}
            layoutMode="scrollable"
            variant="default"
            tabContextMenu={renderFileTabContextMenu}
          />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {hasOpenFile || !treeVisible ? (
          // Hidden rather than unmounted so a hidden editor keeps its state.
          <div className={cn('h-full min-w-0 flex-1', hasOpenFile && !showsEditor && 'hidden')}>
            {hasOpenFile ? (
              <FilesEditorSlot visible={zoneOpen && shown && showsEditor} onKeyDownCapture={onKeyDownCapture} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
                <div className="typography-ui-header text-foreground">{t('contextPanel.editorEmpty.title')}</div>
                <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.editorEmpty.description')}</div>
              </div>
            )}
          </div>
        ) : null}
        <EditorTreeColumn visible={treeVisible} active={zoneOpen && shown} fill={!showsEditor} />
      </div>
    </div>
  );
};
