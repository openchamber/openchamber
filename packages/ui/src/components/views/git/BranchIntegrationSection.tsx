import React from 'react';
import {
  RiGitMergeLine,
  RiGitBranchLine,
  RiLoader4Line,
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { m } from '@/lib/i18n/messages';

type OperationType = 'merge' | 'rebase';

export interface OperationLogEntry {
  message: string;
  status: 'pending' | 'running' | 'done' | 'error';
  timestamp: number;
}

interface BranchIntegrationSectionProps {
  currentBranch: string | null | undefined;
  localBranches: string[];
  remoteBranches: string[];
  onMerge: (branch: string) => void;
  onRebase: (branch: string) => void;
  disabled?: boolean;
  isOperating?: boolean;
  operationLogs?: OperationLogEntry[];
  onOperationComplete?: () => void;
  mode?: 'dialog' | 'inline';
}

export const BranchIntegrationSection: React.FC<BranchIntegrationSectionProps> = ({
  currentBranch,
  localBranches,
  remoteBranches,
  onMerge,
  onRebase,
  disabled = false,
  isOperating = false,
  operationLogs = [],
  onOperationComplete,
  mode = 'dialog',
}) => {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [operation, setOperation] = React.useState<OperationType>('merge');
  const [selectedBranch, setSelectedBranch] = React.useState<string | null>(null);
  const [branchDropdownOpen, setBranchDropdownOpen] = React.useState(false);
  const [branchSearch, setBranchSearch] = React.useState('');
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const logContainerRef = React.useRef<HTMLDivElement>(null);

  const isDisabled = disabled || isOperating;
  const targetBranchLabel = currentBranch || m.gitBranchCurrentBranch();
  
  // Check if operation completed (all logs are done or error)
  const operationCompleted = operationLogs.length > 0 && 
    operationLogs.every(log => log.status === 'done' || log.status === 'error');
  const hasError = operationLogs.some(log => log.status === 'error');

  // Auto-scroll log container when new entries are added
  React.useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [operationLogs]);

  // Filter branches based on search
  const filteredLocal = React.useMemo(() => {
    const term = branchSearch.toLowerCase();
    const filtered = localBranches.filter((b) => b !== currentBranch);
    if (!term) return filtered;
    return filtered.filter((b) => b.toLowerCase().includes(term));
  }, [branchSearch, localBranches, currentBranch]);

  const filteredRemote = React.useMemo(() => {
    const term = branchSearch.toLowerCase();
    if (!term) return remoteBranches;
    return remoteBranches.filter((b) => b.toLowerCase().includes(term));
  }, [branchSearch, remoteBranches]);

  const handleOpenDialog = () => {
    setDialogOpen(true);
    setSelectedBranch(null);
    setOperation('merge');
    setBranchSearch('');
  };

  const handleSelectBranch = (branch: string) => {
    setSelectedBranch(branch);
    setBranchDropdownOpen(false);
    setBranchSearch('');
  };

  const handleConfirm = () => {
    if (!selectedBranch) return;
    
    // Don't close dialog - keep it open to show progress
    if (operation === 'merge') {
      onMerge(selectedBranch);
    } else {
      onRebase(selectedBranch);
    }
  };

  const handleCancel = () => {
    // Don't allow cancel during operation
    if (isOperating) return;
    
    setSelectedBranch(null);
    setOperation('merge');
    setBranchSearch('');
    setDialogOpen(false);
  };

  const handleClose = () => {
    // Only allow closing when operation is complete or not started
    if (isOperating && !operationCompleted) return;
    
    if (operationCompleted) {
      onOperationComplete?.();
    }
    setSelectedBranch(null);
    setOperation('merge');
    setBranchSearch('');
    setDialogOpen(false);
  };

  React.useEffect(() => {
    if (!branchDropdownOpen) {
      setBranchSearch('');
    }
  }, [branchDropdownOpen]);

  const renderOperating = () => (
    <div className="space-y-3">
      <div
        ref={logContainerRef}
        className="rounded-lg border border-border bg-muted/30 p-3 max-h-48 overflow-y-auto"
      >
        <div className="space-y-2">
          {operationLogs.map((log, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">
                {log.status === 'running' && (
                  <RiLoader4Line className="size-3.5 animate-spin text-primary" />
                )}
                {log.status === 'done' && (
                  <RiCheckLine className="size-3.5 text-success" />
                )}
                {log.status === 'error' && (
                  <RiCloseLine className="size-3.5 text-destructive" />
                )}
                {log.status === 'pending' && (
                  <div className="size-3.5 rounded-full border border-muted-foreground/30" />
                )}
              </div>
              <span
                className={cn(
                  'typography-micro',
                  log.status === 'error' && 'text-destructive',
                  log.status === 'done' && 'text-muted-foreground',
                  log.status === 'running' && 'text-foreground',
                  log.status === 'pending' && 'text-muted-foreground/60'
                )}
              >
                {log.message}
              </span>
            </div>
          ))}
        </div>
      </div>

      {operationCompleted ? (
        mode === 'dialog' ? (
          <DialogFooter>
            <Button variant="default" size="sm" onClick={handleClose}>
              {hasError ? 'Close' : 'Done'}
            </Button>
          </DialogFooter>
        ) : (
          <div className="flex justify-end">
            <Button variant="default" size="sm" onClick={handleClose}>
              {hasError ? m.gitBranchClose() : m.gitBranchDone()}
            </Button>
          </div>
        )
      ) : null}
    </div>
  );

  const renderForm = () => (
    <div className="space-y-4">
      {/* Operation Selection */}
      <div className="space-y-3">
        <p className="typography-meta text-muted-foreground">{m.gitBranchOperation()}</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setOperation('merge')}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
              operation === 'merge'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-border/80 hover:bg-muted/50'
            )}
          >
            <div className="flex items-center gap-2">
              <RiGitMergeLine
                className={cn('size-4', operation === 'merge' ? 'text-primary' : 'text-muted-foreground')}
              />
              <span
                className={cn(
                  'typography-ui-label',
                  operation === 'merge' ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {m.gitBranchMerge()}
              </span>
            </div>
            <p className="typography-micro text-muted-foreground">
              {m.gitBranchMergeDescription()}
            </p>
          </button>

          <button
            type="button"
            onClick={() => setOperation('rebase')}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
              operation === 'rebase'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-border/80 hover:bg-muted/50'
            )}
          >
            <div className="flex items-center gap-2">
              <RiGitBranchLine
                className={cn('size-4', operation === 'rebase' ? 'text-primary' : 'text-muted-foreground')}
              />
              <span
                className={cn(
                  'typography-ui-label',
                  operation === 'rebase' ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {m.gitBranchRebase()}
              </span>
            </div>
                    <p className="typography-micro text-muted-foreground">
                      {m.gitBranchRebaseDescription()}
                    </p>
                  </button>
        </div>
      </div>

      {/* Branch Selection */}
      <div className="space-y-3">
        <p className="typography-meta text-muted-foreground">
          {operation === 'merge'
            ? m.gitBranchBranchToMergeIntoTarget({ target_branch: targetBranchLabel })
            : m.gitBranchBranchToRebaseOnto()}
        </p>
        <DropdownMenu open={branchDropdownOpen} onOpenChange={setBranchDropdownOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="lg" className="w-full justify-between">
              <span className={cn('truncate', !selectedBranch && 'text-muted-foreground')}>
                {selectedBranch || m.gitBranchSelectABranch()}
              </span>
              <RiArrowDownSLine className="size-4 opacity-60 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[--radix-dropdown-menu-trigger-width] p-0 max-h-(--radix-dropdown-menu-content-available-height) flex flex-col overflow-hidden"
          >
            <Command className="h-full min-h-0">
              <CommandInput
                ref={searchInputRef}
                placeholder={m.gitBranchSearchBranches()}
                value={branchSearch}
                onValueChange={setBranchSearch}
              />
              <CommandList className="h-full min-h-0" disableHorizontal>
                <CommandEmpty>{m.gitBranchNoBranchesFound()}</CommandEmpty>

                {filteredLocal.length > 0 && (
                  <CommandGroup heading={m.gitBranchLocalBranches()}>
                    {filteredLocal.map((branch) => (
                      <CommandItem key={`local-${branch}`} onSelect={() => handleSelectBranch(branch)}>
                        <span className="typography-ui-label text-foreground truncate">{branch}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {filteredLocal.length > 0 && filteredRemote.length > 0 ? <CommandSeparator /> : null}

                {filteredRemote.length > 0 && (
                  <CommandGroup heading={m.gitBranchRemoteBranches()}>
                    {filteredRemote.map((branch) => (
                      <CommandItem key={`remote-${branch}`} onSelect={() => handleSelectBranch(branch)}>
                        <span className="typography-ui-label text-foreground truncate">{branch}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Summary */}
      {selectedBranch ? (
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="typography-meta text-muted-foreground">
            {operation === 'merge' ? (
              <>
                {m.gitBranchThisWillMergeSourceIntoTarget({
                  source_branch: selectedBranch || '',
                  target_branch: targetBranchLabel
                })}
              </>
            ) : (
              <>
                {m.gitBranchThisWillRebaseTargetOntoSource({
                  target_branch: targetBranchLabel,
                  source_branch: selectedBranch || ''
                })}
              </>
            )}
          </p>
        </div>
      ) : null}

      {mode === 'dialog' ? (
        <DialogFooter className="gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            {m.commonCancel()}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleConfirm}
            disabled={!selectedBranch}
            className="gap-1.5"
          >
            {operation === 'merge' ? (
              <>
                <RiGitMergeLine className="size-4" />
                {m.gitBranchMerge()}
              </>
            ) : (
              <>
                <RiGitBranchLine className="size-4" />
                {m.gitBranchRebase()}
              </>
            )}
          </Button>
        </DialogFooter>
      ) : (
        <div className="flex items-center gap-2 pt-1">
          <Button variant="destructive" size="sm" onClick={handleCancel} disabled={isDisabled}>
            {m.gitBranchReset()}
          </Button>
          <div className="flex-1" />
          <Button variant="default" size="sm" onClick={handleConfirm} disabled={isDisabled || !selectedBranch}>
            {operation === 'merge' ? m.gitBranchMerge() : m.gitBranchRebase()}
          </Button>
        </div>
      )}
    </div>
  );

  const body = isOperating ? renderOperating() : renderForm();

  if (mode === 'inline') {
    return (
      <section className="border-0 bg-transparent rounded-none">
        <header className="border-b border-border/40 px-0 py-3">
          <div className="space-y-1">
            <div className="typography-ui-header font-semibold text-foreground">{m.gitBranchUpdateBranch()}</div>
            <div className="typography-micro text-muted-foreground">
              {m.gitBranchBringChangesDescription({ target_branch: targetBranchLabel })}
            </div>
          </div>
        </header>
        <div className="pt-3">{body}</div>
      </section>
    );
  }

  return (
    <>
      <Tooltip delayDuration={1000}>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleOpenDialog}
            disabled={isDisabled}
          >
            {isOperating ? (
              <RiLoader4Line className="size-4 animate-spin" />
            ) : (
              <RiGitMergeLine className="size-4" />
            )}
            <span>{m.gitBranchMergeRebase()}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>
          {m.gitBranchTooltipMergeOrRebase()}
        </TooltipContent>
      </Tooltip>

      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (!open) {
          handleClose();
        } else {
          setDialogOpen(true);
        }
      }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{m.gitBranchUpdateBranchDialogTitle()}</DialogTitle>
              <DialogDescription>
              {isOperating ? (
                operationCompleted ? (
                  hasError ? m.gitBranchOperationFailed() : m.gitBranchOperationCompleted()
                ) : (
                  `${operation === 'merge' ? m.gitBranchMergingInProgress() : m.gitBranchRebasingInProgress()}`
                )
              ) : (
                <>
                  {m.gitBranchOperationDescription({ target_branch: targetBranchLabel })}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {body}
        </DialogContent>
      </Dialog>
    </>
  );
};
