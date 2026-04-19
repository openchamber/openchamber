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
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import {
  RiCheckboxBlankLine,
  RiCheckboxLine,
} from '@remixicon/react';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { DirectoryAutocomplete, type DirectoryAutocompleteHandle } from './DirectoryAutocomplete';
import {
  setDirectoryShowHidden,
  useDirectoryShowHidden,
} from '@/lib/directoryShowHidden';
import { normalizePath } from '@/lib/pathUtils';

interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { currentDirectory, homeDirectory, isHomeReady } = useDirectoryStore();
  const { addProject, getActiveProject } = useProjectsStore();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isWindowsRuntime = React.useMemo(
    () => typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent),
    []
  );
  const [pendingPath, setPendingPath] = React.useState<string | null>(null);
  const [pathInputValue, setPathInputValue] = React.useState('');
  const [hasUserSelection, setHasUserSelection] = React.useState(false);
  const [isConfirming, setIsConfirming] = React.useState(false);
  const showHidden = useDirectoryShowHidden();
  const { isDesktop, requestAccess, startAccessing } = useFileSystemAccess();
  const { isMobile } = useDeviceInfo();
  const [autocompleteVisible, setAutocompleteVisible] = React.useState(false);
  const autocompleteRef = React.useRef<DirectoryAutocompleteHandle>(null);

  const normalizeDirectoryPath = React.useCallback((value: string | null | undefined) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = normalizePath(value);
    if (normalized) {
      return normalized;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.replace(/\\/g, '/') : null;
  }, []);

  const toDirectoryRequestPath = React.useCallback((value: string) => {
    const normalized = normalizeDirectoryPath(value) ?? value.trim().replace(/\\/g, '/');
    const converted = normalized.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`);
    return /^[A-Za-z]:$/.test(converted) ? `${converted}/` : converted;
  }, [normalizeDirectoryPath]);

  const workspaceBoundary = React.useMemo(() => {
    if (!isVSCode || typeof window === 'undefined') {
      return null;
    }

    const workspaceFolder = (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } })
      .__VSCODE_CONFIG__?.workspaceFolder;
    return typeof workspaceFolder === 'string'
      ? normalizeDirectoryPath(workspaceFolder)
      : null;
  }, [isVSCode, normalizeDirectoryPath]);

  const defaultPickerPath = isVSCode ? workspaceBoundary : homeDirectory;
  const isDefaultPickerPathReady = isVSCode ? Boolean(workspaceBoundary) : isHomeReady;

  const isWindowsPathLike = React.useCallback((value: string | null | undefined) => {
    if (typeof value !== 'string') {
      return false;
    }

    const trimmed = value.trim();
    return /^\/[A-Za-z](?:\/|$)?/.test(trimmed) || /^[A-Za-z]:(?:[\\/]|$)?/.test(trimmed);
  }, []);

  const isWindowsPathContext = React.useMemo(() => {
    if (!isWindowsRuntime) {
      return false;
    }

    return [currentDirectory, homeDirectory, workspaceBoundary, pathInputValue].some((value) => isWindowsPathLike(value));
  }, [currentDirectory, homeDirectory, isWindowsPathLike, isWindowsRuntime, pathInputValue, workspaceBoundary]);

  const supportsPathAutocomplete = React.useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }

    if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.startsWith('~')) {
      return true;
    }

    if (/^[A-Za-z]:(?:[\\/]|$)/.test(trimmed)) {
      return true;
    }

    return /^%userprofile%(?:[\\/]|$)/i.test(trimmed);
  }, []);

  const expandTypedPath = React.useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }

    let expanded = trimmed.replace(/\\/g, '/');
    if (/^[A-Za-z]:$/.test(expanded)) {
      expanded = `${expanded}/`;
    }

    if (/^%userprofile%(?:[\\/]|$)/i.test(trimmed) && homeDirectory) {
      expanded = expanded.replace(/^%userprofile%/i, homeDirectory);
    } else if (expanded.startsWith('~') && homeDirectory) {
      expanded = expanded.replace(/^~/, homeDirectory);
    }

    return normalizeDirectoryPath(expanded) ?? expanded;
  }, [homeDirectory, normalizeDirectoryPath]);

  const formatInputPath = React.useCallback((
    path: string | null | undefined,
    options?: { preserveTrailingSeparator?: boolean }
  ) => {
    const normalizedPath = normalizeDirectoryPath(path);
    if (!normalizedPath) {
      return '';
    }

    if (isWindowsPathContext || isWindowsPathLike(normalizedPath)) {
      const windowsPath = toDirectoryRequestPath(normalizedPath);
      let formatted = windowsPath === '/'
        ? '\\'
        : windowsPath.replace(/\//g, '\\');

      if (options?.preserveTrailingSeparator && !formatted.endsWith('\\')) {
        formatted = `${formatted}\\`;
      }

      return formatted;
    }

    if (options?.preserveTrailingSeparator) {
      if (!normalizedPath.endsWith('/')) {
        return `${normalizedPath}/`;
      }
    }

    return normalizedPath;
  }, [isWindowsPathContext, isWindowsPathLike, normalizeDirectoryPath, toDirectoryRequestPath]);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setHasUserSelection(false);
      setIsConfirming(false);
      setAutocompleteVisible(false);
      // Initialize with active project or current directory
      const activeProject = getActiveProject();
      const initialPath = activeProject?.path || currentDirectory || defaultPickerPath || '';
      const initialInputValue = formatInputPath(initialPath);
      setPendingPath(initialPath);
      setPathInputValue(initialInputValue);
    }
  }, [open, currentDirectory, defaultPickerPath, formatInputPath, getActiveProject]);

  // Fill the input once the default picker path is ready and nothing has been selected yet.
  React.useEffect(() => {
    if (!open || hasUserSelection || pendingPath) {
      return;
    }
    if (defaultPickerPath && isDefaultPickerPathReady) {
      const initialInputValue = formatInputPath(defaultPickerPath);
      setPendingPath(defaultPickerPath);
      setHasUserSelection(true);
      setPathInputValue(initialInputValue);
    }
  }, [defaultPickerPath, formatInputPath, hasUserSelection, isDefaultPickerPathReady, open, pendingPath]);


  const handleClose = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const isWindowsDrivePickerPath = React.useCallback((path: string | null | undefined) => {
    const normalized = normalizeDirectoryPath(path);
    return Boolean(!workspaceBoundary && isWindowsPathContext && normalized === '/');
  }, [isWindowsPathContext, normalizeDirectoryPath, workspaceBoundary]);

  const isPathWithinWorkspaceBoundary = React.useCallback((path: string) => {
    if (!workspaceBoundary) {
      return true;
    }

    const normalizedTarget = normalizeDirectoryPath(path);
    if (!normalizedTarget) {
      return false;
    }

    if (workspaceBoundary === '/') {
      return normalizedTarget.startsWith('/');
    }

    return normalizedTarget === workspaceBoundary || normalizedTarget.startsWith(`${workspaceBoundary}/`);
  }, [workspaceBoundary, normalizeDirectoryPath]);

  const finalizeSelection = React.useCallback(async (targetPath: string) => {
    const normalizedTargetPath = expandTypedPath(targetPath);
    if (!normalizedTargetPath || isConfirming) {
      return;
    }

    setIsConfirming(true);
    try {
      if (isWindowsDrivePickerPath(normalizedTargetPath)) {
        return;
      }

      if (isVSCode && workspaceBoundary && !isPathWithinWorkspaceBoundary(normalizedTargetPath)) {
        toast.error('Directory must stay inside the workspace', {
          description: 'VS Code can only browse within the current workspace folder.',
        });
        return;
      }

      let resolvedPath = normalizedTargetPath;
      let projectId: string | undefined;

      if (isDesktop) {
        const accessResult = await requestAccess(toDirectoryRequestPath(normalizedTargetPath));
        if (!accessResult.success) {
          toast.error('Unable to access directory', {
            description: accessResult.error || 'Desktop denied directory access.',
          });
          return;
        }
        resolvedPath = normalizeDirectoryPath(accessResult.path ?? normalizedTargetPath) ?? normalizedTargetPath;
        projectId = accessResult.projectId;

        const startResult = await startAccessing(toDirectoryRequestPath(resolvedPath));
        if (!startResult.success) {
          toast.error('Failed to open directory', {
            description: startResult.error || 'Desktop could not grant file access.',
          });
          return;
        }
      }

      const added = addProject(resolvedPath, { id: projectId });
      if (!added) {
        toast.error('Failed to add project', {
          description: 'Please select a valid directory path.',
        });
        return;
      }

      handleClose();
    } catch (error) {
      toast.error('Failed to select directory', {
        description: error instanceof Error ? error.message : 'Unknown error occurred.',
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
    expandTypedPath,
    isPathWithinWorkspaceBoundary,
    isVSCode,
    isWindowsDrivePickerPath,
    normalizeDirectoryPath,
    toDirectoryRequestPath,
    workspaceBoundary,
  ]);

  const handleConfirm = React.useCallback(async () => {
    const typedPath = pathInputValue.trim();
    const pathToUse = typedPath ? expandTypedPath(typedPath) : pendingPath;
    if (!pathToUse) {
      return;
    }
    await finalizeSelection(pathToUse);
  }, [expandTypedPath, finalizeSelection, pathInputValue, pendingPath]);

  const handleSelectPath = React.useCallback((path: string) => {
    setPendingPath(path);
    setHasUserSelection(true);
    setPathInputValue(formatInputPath(path));
  }, [formatInputPath]);

  const handleDoubleClickPath = React.useCallback(async (path: string) => {
    setPendingPath(path);
    setHasUserSelection(true);
    setPathInputValue(formatInputPath(path));
    await finalizeSelection(path);
  }, [finalizeSelection, formatInputPath]);

  const handlePathInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPathInputValue(value);
    setHasUserSelection(true);
    // Show autocomplete when typing a path
    const supportsAutocomplete = supportsPathAutocomplete(value);
    setAutocompleteVisible(supportsAutocomplete);
    // Update pending path if it looks like a valid path
    if (supportsAutocomplete) {
      setPendingPath(expandTypedPath(value));
    }
  }, [expandTypedPath, supportsPathAutocomplete]);

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
    setPendingPath(normalizeDirectoryPath(path));
    setHasUserSelection(true);
    setPathInputValue(formatInputPath(path, { preserveTrailingSeparator: true }));
    // Keep autocomplete open to allow further drilling down
  }, [formatInputPath, normalizeDirectoryPath]);

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
      Show hidden
    </button>
  );

  const dialogHeader = (
    <DialogHeader className="flex-shrink-0 px-4 pb-2 pt-[calc(var(--oc-safe-area-top,0px)+0.5rem)] sm:px-0 sm:pb-3 sm:pt-0">
      <DialogTitle>Add project directory</DialogTitle>
      <div className="hidden sm:flex sm:items-center sm:justify-between sm:gap-4">
        <DialogDescription className="flex-1">
          Choose a folder to add as a project.
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
        placeholder="Enter path or select from tree..."
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        className="font-mono typography-meta"
      />
      <DirectoryAutocomplete
        ref={autocompleteRef}
        inputValue={pathInputValue}
        homeDirectory={homeDirectory}
        scopeBoundary={workspaceBoundary}
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
        rootDirectory={isVSCode ? workspaceBoundary : null}
        isRootReady={isVSCode ? Boolean(workspaceBoundary) : true}
      />
    </div>
  );

  // Mobile: use flex layout where tree takes remaining space
  const mobileContent = (
    <div className="flex flex-col gap-3 h-full">
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
          rootDirectory={isVSCode ? workspaceBoundary : null}
          isRootReady={isVSCode ? Boolean(workspaceBoundary) : true}
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
        Cancel
      </Button>
      <Button
        onClick={handleConfirm}
        disabled={
          isConfirming
          || !hasUserSelection
          || (!pendingPath && !pathInputValue.trim())
          || isWindowsDrivePickerPath(pathInputValue.trim() || pendingPath)
        }
        className="flex-1 sm:flex-none sm:w-auto sm:min-w-[140px]"
      >
        {isConfirming ? 'Adding...' : 'Add Project'}
      </Button>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        onClose={() => onOpenChange(false)}
        title="Add project directory"
        className="max-w-full"
        contentMaxHeightClassName="max-h-[min(70vh,520px)] h-[min(70vh,520px)]"
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
