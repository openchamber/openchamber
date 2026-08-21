import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { FileNode } from './helpers';
import { getDisplayPath } from './helpers';
import { ScrollingFileName } from './ScrollingFileName';

// ── Props for the preview layout shell ─────────────────────────────────────────

interface FilesPreviewProps {
  showEditorTabsRow: boolean;
  isMobile: boolean;
  showMobilePageContent: boolean;
  onHideMobileContent: () => void;
  openFiles: FileNode[];
  selectedFile: FileNode | null;
  onSelectFile: (node: FileNode) => void;
  onCloseFile: (path: string) => void;
  editorTabsOverflow: { left: boolean; right: boolean };
  editorTabsScrollRef: React.RefObject<HTMLDivElement | null>;
  alwaysShowActions: boolean;
  root: string;
  /** The file content area rendered inline */
  children: React.ReactNode;
  /** Floating controls rendered inside the preview */
  floatingControlsSlot: React.ReactNode;
  /** Trigger button to show floating controls */
  floatingControlsTrigger: React.ReactNode;
  /** Whether to show the floating toolbar controls area */
  isFloatingToolbarOpen: boolean;
  /** Discard confirmation dialog props */
  confirmDiscardOpen: boolean;
  isSaving: boolean;
  onSaveAndContinue: () => void;
  onDiscardAndContinue: () => void;
  /** Close file 'X' button */ 
  renderCloseButton: (file: FileNode) => React.ReactNode;
}

// ── Component ──────────────────────────────────────────────────────────────────

export const FilesPreview: React.FC<FilesPreviewProps> = ({
  showEditorTabsRow,
  isMobile,
  showMobilePageContent,
  onHideMobileContent,
  openFiles,
  selectedFile,
  onSelectFile,
  onCloseFile,
  editorTabsOverflow,
  editorTabsScrollRef,
  alwaysShowActions,
  root,
  children,
  floatingControlsSlot,
  floatingControlsTrigger,
  isFloatingToolbarOpen,
  confirmDiscardOpen,
  isSaving,
  onSaveAndContinue,
  onDiscardAndContinue,
  renderCloseButton,
}) => {
  const { t } = useI18n();

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden">
      {/* Confirm discard dialog */}
      <Dialog open={confirmDiscardOpen} onOpenChange={(open) => {
        if (!open) {
          // Intentional no-op — keep dialog modal
        }
      }}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('filesView.unsaved.title')}</DialogTitle>
            <DialogDescription>
              {t('filesView.unsaved.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
          <Button
            variant="outline"
            onClick={onSaveAndContinue}
            disabled={isSaving}
            className="border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)] hover:bg-[rgb(var(--status-success)/0.2)]"
            >
              {t('filesView.unsaved.saveChanges')}
            </Button>
            <Button variant="destructive" onClick={onDiscardAndContinue}>{t('filesView.unsaved.discard')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Row 1: Editor tabs */}
      <div className={cn('flex flex-col flex-shrink-0', showEditorTabsRow && 'border-b border-border/40')}>
        {showEditorTabsRow ? (
          <div className="flex min-w-0 items-center px-3 py-1.5">
            {/* Mobile back button */}
            {isMobile && showMobilePageContent && (
              <button
                type="button"
                onClick={onHideMobileContent}
                aria-label={t('filesView.editor.back')}
                className="inline-flex size-7 flex-shrink-0 items-center justify-center mr-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Icon name="arrow-left-s" className="size-5" />
              </button>
            )}

            {/* Mobile tab dropdown / Desktop scrollable tabs */}
            {isMobile ? (
              selectedFile ? (
                <DropdownMenu_tabs
                  openFiles={openFiles}
                  selectedFile={selectedFile}
                  onSelectFile={onSelectFile}
                  renderCloseButton={renderCloseButton}
                />
              ) : (
                <div className="typography-ui-label font-medium truncate">{t('filesView.editor.selectFile')}</div>
              )
            ) : (
              openFiles.length > 0 ? (
                <EditorTabsRow
                  openFiles={openFiles}
                  selectedFile={selectedFile}
                  editorTabsOverflow={editorTabsOverflow}
                  editorTabsScrollRef={editorTabsScrollRef}
                  onSelectFile={onSelectFile}
                  onCloseFile={onCloseFile}
                  root={root}
                  alwaysShowActions={alwaysShowActions}
                />
              ) : (
                <div className="typography-ui-label font-medium truncate">{t('filesView.editor.selectFile')}</div>
              )
            )}
          </div>
        ) : null}
      </div>

      {/* Preview content area */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        {/* Floating toolbar trigger */}
        {selectedFile && !isFloatingToolbarOpen && (
          <div className="absolute right-3 top-3 z-30">
            {floatingControlsTrigger}
          </div>
        )}
        
        {/* Floating toolbar */}
        {selectedFile && isFloatingToolbarOpen && (
          <div className="absolute right-3 top-3 z-30 pointer-events-none">
            {floatingControlsSlot}
          </div>
        )}

        {/* File content */}
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {children}
        </ScrollableOverlay>
      </div>
    </div>
  );
};

// ── Mobile tab dropdown ────────────────────────────────────────────────────────
// (Inlined from the original, this is a small internal helper)

import {
  DropdownMenu as DropdownMenu_Root,
  DropdownMenuContent as DropdownMenu_Content,
  DropdownMenuItem as DropdownMenu_Item,
  DropdownMenuTrigger as DropdownMenu_Trigger,
} from '@/components/ui/dropdown-menu';

const DropdownMenu_tabs: React.FC<{
  openFiles: FileNode[];
  selectedFile: FileNode;
  onSelectFile: (node: FileNode) => void;
  renderCloseButton: (file: FileNode) => React.ReactNode;
}> = ({ openFiles, selectedFile, onSelectFile, renderCloseButton }) => {
  const { t } = useI18n();
  return (
    <DropdownMenu_Root>
      <DropdownMenu_Trigger asChild>
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-center gap-1 text-left typography-ui-label font-medium"
          aria-label={t('filesView.editor.openFilesAria')}
        >
          <FileTypeIcon filePath={selectedFile.path} extension={selectedFile.extension} className="size-3.5 flex-shrink-0" />
          <ScrollingFileName name={selectedFile.name} />
          <Icon name="arrow-down-s" className="size-4 flex-shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenu_Trigger>
      <DropdownMenu_Content align="start" className="w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
        {openFiles.map((file) => {
          const isActive = selectedFile.path === file.path;
          return (
            <DropdownMenu_Item
              key={file.path}
              onSelect={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest('[data-close-open-file]')) {
                  event.preventDefault();
                  return;
                }
                if (!isActive) {
                  onSelectFile(file);
                }
              }}
              className={cn(
                'flex min-w-0 items-center justify-between gap-2 overflow-hidden',
                isActive && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                <FileTypeIcon filePath={file.path} extension={file.extension} className="size-3.5 flex-shrink-0" />
                <ScrollingFileName name={file.name} />
              </span>
              {renderCloseButton(file)}
            </DropdownMenu_Item>
          );
        })}
      </DropdownMenu_Content>
    </DropdownMenu_Root>
  );
};

// ── Desktop editor tabs row ────────────────────────────────────────────────────

const EditorTabsRow: React.FC<{
  openFiles: FileNode[];
  selectedFile: FileNode | null;
  editorTabsOverflow: { left: boolean; right: boolean };
  editorTabsScrollRef: React.RefObject<HTMLDivElement | null>;
  onSelectFile: (node: FileNode) => void;
  onCloseFile: (path: string) => void;
  root: string;
  alwaysShowActions: boolean;
}> = ({ openFiles, selectedFile, editorTabsOverflow, editorTabsScrollRef, onSelectFile, onCloseFile, root, alwaysShowActions }) => {
  const { t } = useI18n();
  return (
    <div className="relative min-w-0 flex-1">
      {editorTabsOverflow.left && (
        <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r from-background to-transparent" />
      )}
      {editorTabsOverflow.right && (
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l from-background to-transparent" />
      )}
      <div
        ref={editorTabsScrollRef}
        className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {openFiles.map((file) => {
          const isActive = selectedFile?.path === file.path;
          return (
            <div
              key={file.path}
              title={getDisplayPath(root, file.path)}
              className={cn(
                'group inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-ui-label transition-colors whitespace-nowrap',
                isActive
                  ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                  : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]'
              )}
            >
              <FileTypeIcon filePath={file.path} extension={file.extension} className="size-3.5 flex-shrink-0" />
              <button
                type="button"
                onClick={() => {
                  if (!isActive) {
                    onSelectFile(file);
                  }
                }}
                className="max-w-[12rem] truncate text-left"
              >
                {file.name}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseFile(file.path);
                }}
                className={cn(
                  'rounded-sm p-0.5 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                  !isActive && !alwaysShowActions && 'opacity-0 group-hover:opacity-100'
                )}
                aria-label={t('filesView.editor.closeFileAria', { name: file.name })}
              >
                <Icon name="close" className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── Fullscreen viewer ──────────────────────────────────────────────────────────

interface FullscreenPreviewProps {
  selectedFile: FileNode | null;
  isFullscreen: boolean;
  /** Slot for the fullscreen floating controls */
  floatingControlsSlot: React.ReactNode;
  children: React.ReactNode;
}

export const FullscreenPreview: React.FC<FullscreenPreviewProps> = ({
  selectedFile,
  isFullscreen,
  floatingControlsSlot,
  children,
}) => {
  if (!isFullscreen || !selectedFile) return null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <div className="flex-1 min-h-0 min-w-0 relative">
        <div className="absolute right-4 top-4 z-30">
          {floatingControlsSlot}
        </div>
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {children}
        </ScrollableOverlay>
      </div>
    </div>
  );
};
