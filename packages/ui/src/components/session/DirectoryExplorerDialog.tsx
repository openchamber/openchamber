import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DirectoryTree } from './DirectoryTree';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { cn, formatPathForDisplay } from '@/lib/utils';
import { toast } from '@/components/ui';
import {
  RiCheckboxBlankLine,
  RiCheckboxLine,
} from '@remixicon/react';
import { useDeviceInfo } from '@/lib/device';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { DirectoryAutocomplete, type DirectoryAutocompleteHandle } from './DirectoryAutocomplete';
import {
  setDirectoryShowHidden,
  useDirectoryShowHidden,
} from '@/lib/directoryShowHidden';
import { useI18n } from '@/lib/i18n';

interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const { currentDirectory, homeDirectory, isHomeReady } = useDirectoryStore();
  const { addProject, getActiveProject } = useProjectsStore();
  const [pendingPath, setPendingPath] = React.useState<string | null>(null);
  const [pathInputValue, setPathInputValue] = React.useState('');
  const [hasUserSelection, setHasUserSelection] = React.useState(false);
  const [isConfirming, setIsConfirming] = React.useState(false);
  const showHidden = useDirectoryShowHidden();
  const { isDesktop, requestAccess, startAccessing } = useFileSystemAccess();
  const { isMobile } = useDeviceInfo();
  const [autocompleteVisible, setAutocompleteVisible] = React.useState(false);
  const autocompleteRef = React.useRef<DirectoryAutocompleteHandle>(null);

  // Helper to format path for display
  const formatPath = React.useCallback((path: string | null) => {
    if (!path) return '';
    return formatPathForDisplay(path, homeDirectory);
  }, [homeDirectory]);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setHasUserSelection(false);
      setIsConfirming(false);
      setAutocompleteVisible(false);
      // Initialize with active project or current directory
      const activeProject = getActiveProject();
      const initialPath = activeProject?.path || currentDirectory || homeDirectory || '';
      setPendingPath(initialPath);
      setPathInputValue(formatPath(initialPath));
    }
  }, [open, currentDirectory, homeDirectory, formatPath, getActiveProject]);

  // Set initial pending path to home when ready (only if not yet selected)
  React.useEffect(() => {
    if (!open || hasUserSelection || pendingPath) {
      return;
    }
    if (homeDirectory && isHomeReady) {
      setPendingPath(homeDirectory);
      setHasUserSelection(true);
      setPathInputValue('~');
    }
  }, [open, hasUserSelection, pendingPath, homeDirectory, isHomeReady]);


  const handleClose = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const finalizeSelection = React.useCallback(async (targetPath: string) => {
    if (!targetPath || isConfirming) {
      return;
    }
    setIsConfirming(true);
    try {
      let resolvedPath = targetPath;
      let projectId: string | undefined;

      if (isDesktop) {
        const accessResult = await requestAccess(targetPath);
        if (!accessResult.success) {
          toast.error(t('directoryExplorerDialog.toast.unableToAccessDirectory'), {
            description: accessResult.error || t('directoryExplorerDialog.toast.desktopDeniedAccess'),
          });
          return;
        }
        resolvedPath = accessResult.path ?? targetPath;
        projectId = accessResult.projectId;

        const startResult = await startAccessing(resolvedPath);
        if (!startResult.success) {
          toast.error(t('directoryExplorerDialog.toast.failedToOpenDirectory'), {
            description: startResult.error || t('directoryExplorerDialog.toast.desktopCouldNotGrantAccess'),
          });
          return;
        }
      }

      const added = addProject(resolvedPath, { id: projectId });
      if (!added) {
        toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), {
          description: t('directoryExplorerDialog.toast.selectValidDirectoryPath'),
        });
        return;
      }

      handleClose();
    } catch (error) {
      toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
        description: error instanceof Error ? error.message : t('directoryExplorerDialog.toast.unknownError'),
      });
    } finally {
      setIsConfirming(false);
    }
  }, [
    addProject,
    handleClose,
    isDesktop,
    requestAccess,
    startAccessing,
    isConfirming,
    t,
  ]);

  const handleConfirm = React.useCallback(async () => {
    const pathToUse = pathInputValue.trim() || pendingPath;
    if (!pathToUse) {
      return;
    }
    await finalizeSelection(pathToUse);
  }, [finalizeSelection, pathInputValue, pendingPath]);

  const handleSelectPath = React.useCallback((path: string) => {
    setPendingPath(path);
    setHasUserSelection(true);
    setPathInputValue(formatPath(path));
  }, [formatPath]);

  const handleDoubleClickPath = React.useCallback(async (path: string) => {
    setPendingPath(path);
    setHasUserSelection(true);
    setPathInputValue(formatPath(path));
    await finalizeSelection(path);
  }, [finalizeSelection, formatPath]);

  const handlePathInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPathInputValue(value);
    setHasUserSelection(true);
    // Show autocomplete when typing a path
    setAutocompleteVisible(value.startsWith('/') || value.startsWith('~'));
    // Update pending path if it looks like a valid path
    if (value.startsWith('/') || value.startsWith('~')) {
      // Expand ~ to home directory
      const expandedPath = value.startsWith('~') && homeDirectory
        ? value.replace(/^~/, homeDirectory)
        : value;
      setPendingPath(expandedPath);
    }
  }, [homeDirectory]);

  const handlePathInputKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Let autocomplete handle the key first if visible
    if (autocompleteRef.current?.handleKeyDown(e)) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  }, [handleConfirm]);

  const handleAutocompleteSuggestion = React.useCallback((path: string) => {
    setPendingPath(path);
    setHasUserSelection(true);
    setPathInputValue(formatPath(path));
    // Keep autocomplete open to allow further drilling down
  }, [formatPath]);

  const handleAutocompleteClose = React.useCallback(() => {
    setAutocompleteVisible(false);
  }, []);

  const toggleShowHidden = React.useCallback(() => {
    setDirectoryShowHidden(!showHidden);
  }, [showHidden]);



  const showHiddenToggle = (
    <button
      type="button"
      onClick={toggleShowHidden}
      className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-interactive-hover/40 transition-colors typography-meta text-muted-foreground flex-shrink-0"
    >
      {showHidden ? (
        <RiCheckboxLine className="h-4 w-4 text-primary" />
      ) : (
        <RiCheckboxBlankLine className="h-4 w-4" />
      )}
      {t('directoryExplorerDialog.toggle.showHidden')}
    </button>
  );

  const dialogHeader = (
    <DialogHeader className="flex-shrink-0 px-4 pb-2 pt-[calc(var(--oc-safe-area-top,0px)+0.5rem)] sm:px-0 sm:pb-3 sm:pt-0">
      <DialogTitle>{t('directoryExplorerDialog.title')}</DialogTitle>
      <div className="hidden sm:flex sm:items-center sm:justify-between sm:gap-4">
        <DialogDescription className="flex-1">
          {t('directoryExplorerDialog.description')}
        </DialogDescription>
        {showHiddenToggle}
      </div>
    </DialogHeader>
  );

  const pathInputSection = (
    <div className="relative">
      <Input
        value={pathInputValue}
        onChange={handlePathInputChange}
        onKeyDown={handlePathInputKeyDown}
        placeholder={t('directoryExplorerDialog.pathInput.placeholder')}
        className="font-mono typography-meta"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
      <DirectoryAutocomplete
        ref={autocompleteRef}
        inputValue={pathInputValue}
        homeDirectory={homeDirectory}
        onSelectSuggestion={handleAutocompleteSuggestion}
        visible={autocompleteVisible}
        onClose={handleAutocompleteClose}
        showHidden={showHidden}
      />
    </div>
  );

  const treeSection = (
    <div className="flex-1 min-h-0 rounded-xl border border-border/40 bg-sidebar/70 overflow-hidden flex flex-col">
      <DirectoryTree
        variant="inline"
        currentPath={pendingPath ?? currentDirectory}
        onSelectPath={handleSelectPath}
        onDoubleClickPath={handleDoubleClickPath}
        className="flex-1 min-h-0 sm:min-h-[280px] sm:max-h-[380px]"
        selectionBehavior="deferred"
        showHidden={showHidden}
        rootDirectory={isHomeReady ? homeDirectory : null}
        isRootReady={isHomeReady}
      />
    </div>
  );

  // Mobile: use flex layout where tree takes remaining space
  const mobileContent = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex-shrink-0">{pathInputSection}</div>
      <div className="flex-shrink-0 flex items-center justify-end">
        {showHiddenToggle}
      </div>
      <div className="flex-1 min-h-0 rounded-xl border border-border/40 bg-sidebar/70 overflow-hidden flex flex-col">
        <DirectoryTree
          variant="inline"
          currentPath={pendingPath ?? currentDirectory}
          onSelectPath={handleSelectPath}
          onDoubleClickPath={handleDoubleClickPath}
          className="flex-1 min-h-0"
          selectionBehavior="deferred"
          showHidden={showHidden}
          rootDirectory={isHomeReady ? homeDirectory : null}
          isRootReady={isHomeReady}
          alwaysShowActions
        />
      </div>
    </div>
  );

  const desktopContent = (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col gap-3">
      {pathInputSection}
      {treeSection}
    </div>
  );

  const renderActionButtons = () => (
    <>
      <Button
        variant="ghost"
        onClick={handleClose}
        disabled={isConfirming}
        className="flex-1 sm:flex-none sm:w-auto"
      >
        {t('directoryExplorerDialog.actions.cancel')}
      </Button>
      <Button
        onClick={handleConfirm}
        disabled={isConfirming || !hasUserSelection || (!pendingPath && !pathInputValue.trim())}
        className="flex-1 sm:flex-none sm:w-auto sm:min-w-[140px]"
      >
        {isConfirming ? t('directoryExplorerDialog.actions.adding') : t('directoryExplorerDialog.actions.addProject')}
      </Button>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        onClose={() => onOpenChange(false)}
        title={t('directoryExplorerDialog.title')}
        className="h-[88dvh] max-h-[720px] max-w-full"
        contentMaxHeightClassName="flex-1"
        footer={<div className="flex flex-row gap-2">{renderActionButtons()}</div>}
      >
        {mobileContent}
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex w-full max-w-[min(560px,100vw)] max-h-[calc(100vh-32px)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[80vh] sm:max-w-xl sm:p-6'
        )}
        onOpenAutoFocus={(e) => {
          // Prevent auto-focus on input to avoid text selection
          e.preventDefault();
        }}
      >
        {dialogHeader}
        {desktopContent}
        <DialogFooter
          className="sticky bottom-0 flex w-full flex-shrink-0 flex-row gap-2 border-t border-border/40 bg-sidebar px-4 py-3 sm:static sm:justify-end sm:border-0 sm:bg-transparent sm:px-0 sm:pt-4 sm:pb-0"
        >
          {renderActionButtons()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
