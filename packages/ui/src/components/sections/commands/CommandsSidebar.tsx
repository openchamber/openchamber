import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { isMobileDeviceViaCSS } from '@/lib/device';
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RiAddLine, RiTerminalBoxLine, RiMore2Line, RiDeleteBinLine, RiFileCopyLine, RiRestartLine, RiEditLine } from '@remixicon/react';
import { useCommandsStore, isCommandBuiltIn, type Command } from '@/stores/useCommandsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { BackendSwitcher } from '@/components/sections/shared/BackendSwitcher';
import { BackendUnsupported } from '@/components/sections/shared/BackendUnsupported';
import { useBackendsStore } from '@/stores/useBackendsStore';

interface CommandsSidebarProps {
  onItemSelect?: () => void;
}

export const CommandsSidebar: React.FC<CommandsSidebarProps> = ({ onItemSelect }) => {
  const defaultBackendId = useBackendsStore((state) => state.defaultBackendId);
  const hasCapability = useBackendsStore((state) => state.hasCapability);
  const getBackendFn = useBackendsStore((state) => state.getBackend);
  const [selectedBackendId, setSelectedBackendId] = React.useState('');

  React.useEffect(() => {
    if (defaultBackendId && !selectedBackendId) {
      setSelectedBackendId(defaultBackendId);
    }
  }, [defaultBackendId, selectedBackendId]);

  const backendSupportsCommands = selectedBackendId ? hasCapability(selectedBackendId, 'commands') : true;
  const selectedBackend = selectedBackendId ? getBackendFn(selectedBackendId) : undefined;
  const isCodexBackend = selectedBackendId === 'codex';

  // Clear selection when switching backends so the page resets
  const prevBackendRef = React.useRef(selectedBackendId);
  React.useEffect(() => {
    if (prevBackendRef.current && prevBackendRef.current !== selectedBackendId) {
      useCommandsStore.getState().setSelectedCommand(null);
      useCommandsStore.getState().setCommandDraft(null);
    }
    prevBackendRef.current = selectedBackendId;
  }, [selectedBackendId]);

  // Codex custom prompts loaded from control surface
  const [codexPrompts, setCodexPrompts] = React.useState<Array<{ name: string; description?: string; template?: string }>>([]);
  const [codexPromptsLoading, setCodexPromptsLoading] = React.useState(false);
  React.useEffect(() => {
    if (!isCodexBackend) {
      setCodexPrompts([]);
      return;
    }
    let cancelled = false;
    setCodexPromptsLoading(true);
    void (async () => {
      try {
        const response = await fetch('/api/openchamber/harness/control-surface?backendId=codex', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok || cancelled) return;
        const data = await response.json();
        if (cancelled) return;
        const items = Array.isArray(data?.commandSelector?.items) ? data.commandSelector.items : [];
        setCodexPrompts(items.map((item: { name?: string; description?: string; template?: string }) => ({
          name: typeof item.name === 'string' ? item.name : '',
          description: typeof item.description === 'string' ? item.description : undefined,
          template: typeof item.template === 'string' ? item.template : undefined,
        })).filter((p: { name: string }) => p.name.length > 0));
      } catch {
        // ignore
      } finally {
        if (!cancelled) setCodexPromptsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isCodexBackend]);

  const [renameDialogCommand, setRenameDialogCommand] = React.useState<Command | null>(null);
  const [renameNewName, setRenameNewName] = React.useState('');
  const [confirmActionCommand, setConfirmActionCommand] = React.useState<Command | null>(null);
  const [confirmActionType, setConfirmActionType] = React.useState<'delete' | 'reset' | null>(null);
  const [isConfirmActionPending, setIsConfirmActionPending] = React.useState(false);
  const [openMenuCommand, setOpenMenuCommand] = React.useState<string | null>(null);

  const {
    selectedCommandName,
    commands,
    setSelectedCommand,
    setCommandDraft,
    createCommand,
    deleteCommand,
    loadCommands,
  } = useCommandsStore();
  const { skills, loadSkills } = useSkillsStore();

  React.useEffect(() => {
    loadCommands();
    loadSkills();
  }, [loadCommands, loadSkills]);

  const skillNames = React.useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);
  const commandOnlyItems = React.useMemo(
    () => commands.filter((command) => !skillNames.has(command.name)),
    [commands, skillNames],
  );

  React.useEffect(() => {
    if (!selectedCommandName) {
      return;
    }

    if (skillNames.has(selectedCommandName)) {
      setSelectedCommand(null);
    }
  }, [selectedCommandName, setSelectedCommand, skillNames]);

  const bgClass = 'bg-background';

  const handleCreateNew = () => {
    // Generate unique name
    const baseName = 'new-command';
    let newName = baseName;
    let counter = 1;
    while (commands.some((c) => c.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    // Set draft and open the page for editing
    setCommandDraft({ name: newName, scope: 'user' });
    setSelectedCommand(newName);
    onItemSelect?.();


  };

  const handleDeleteCommand = async (command: Command) => {
    if (isCommandBuiltIn(command)) {
      toast.error('Built-in commands cannot be deleted');
      return;
    }

    setConfirmActionCommand(command);
    setConfirmActionType('delete');
  };

  const handleResetCommand = async (command: Command) => {
    if (!isCommandBuiltIn(command)) {
      return;
    }

    setConfirmActionCommand(command);
    setConfirmActionType('reset');
  };

  const closeConfirmActionDialog = () => {
    setConfirmActionCommand(null);
    setConfirmActionType(null);
  };

  const handleConfirmAction = async () => {
    if (!confirmActionCommand || !confirmActionType) {
      return;
    }

    setIsConfirmActionPending(true);
    const success = await deleteCommand(confirmActionCommand.name);

    if (success) {
      if (confirmActionType === 'delete') {
        toast.success(`Command "${confirmActionCommand.name}" deleted successfully`);
      } else {
        toast.success(`Command "${confirmActionCommand.name}" reset to default`);
      }
      closeConfirmActionDialog();
    } else if (confirmActionType === 'delete') {
      toast.error('Failed to delete command');
    } else {
      toast.error('Failed to reset command');
    }

    setIsConfirmActionPending(false);
  };

  const handleDuplicateCommand = (command: Command) => {
    const baseName = command.name;
    let copyNumber = 1;
    let newName = `${baseName}-copy`;

    while (commands.some((c) => c.name === newName)) {
      copyNumber++;
      newName = `${baseName}-copy-${copyNumber}`;
    }

    // Set draft with prefilled values from source command
    setCommandDraft({
      name: newName,
      scope: command.scope || 'user',
      description: command.description,
      template: command.template,
      agent: command.agent,
      model: command.model,
    });
    setSelectedCommand(newName);


  };

  const handleOpenRenameDialog = (command: Command) => {
    setRenameNewName(command.name);
    setRenameDialogCommand(command);
  };

  const handleRenameCommand = async () => {
    if (!renameDialogCommand) return;

    const sanitizedName = renameNewName.trim().replace(/\s+/g, '-');

    if (!sanitizedName) {
      toast.error('Command name is required');
      return;
    }

    if (sanitizedName === renameDialogCommand.name) {
      setRenameDialogCommand(null);
      return;
    }

    if (commands.some((cmd) => cmd.name === sanitizedName)) {
      toast.error('A command with this name already exists');
      return;
    }

    // Create new command with new name and all existing config
    const success = await createCommand({
      name: sanitizedName,
      description: renameDialogCommand.description,
      template: renameDialogCommand.template,
      agent: renameDialogCommand.agent,
      model: renameDialogCommand.model,
    });

    if (success) {
      // Delete old command
      const deleteSuccess = await deleteCommand(renameDialogCommand.name);
      if (deleteSuccess) {
        toast.success(`Command renamed to "${sanitizedName}"`);
        setSelectedCommand(sanitizedName);
      } else {
        toast.error('Failed to remove old command after rename');
      }
    } else {
      toast.error('Failed to rename command');
    }

    setRenameDialogCommand(null);
  };

  const builtInCommands = commandOnlyItems.filter(isCommandBuiltIn);
  const customCommands = commandOnlyItems.filter((cmd) => !isCommandBuiltIn(cmd));

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">
          {isCodexBackend ? 'Custom Prompts' : 'Commands'}
        </h2>
        <BackendSwitcher
          capability="commands"
          selectedBackendId={selectedBackendId}
          onBackendChange={setSelectedBackendId}
          className="mb-3"
        />
        <SettingsProjectSelector className="mb-3" />
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">
            Total {isCodexBackend ? codexPrompts.filter((p) => p.name.startsWith('prompts:')).length : commandOnlyItems.length}
          </span>
          {isCodexBackend ? (
            <Button size="sm"
              variant="ghost"
              className="h-7 w-7 px-0 -my-1 text-muted-foreground"
              onClick={async () => {
                const baseName = 'new-prompt';
                let name = baseName;
                let counter = 1;
                while (codexPrompts.some((p) => p.name === `prompts:${name}`)) {
                  name = `${baseName}-${counter}`;
                  counter++;
                }
                try {
                  await fetch(`/api/openchamber/codex/prompts/${encodeURIComponent(name)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ description: '', argumentHint: '', template: 'Your prompt here.\n' }),
                  });
                  // Reload prompts
                  const response = await fetch('/api/openchamber/harness/control-surface?backendId=codex', {
                    headers: { Accept: 'application/json' },
                  });
                  if (response.ok) {
                    const data = await response.json();
                    const items = Array.isArray(data?.commandSelector?.items) ? data.commandSelector.items : [];
                    setCodexPrompts(items.map((item: { name?: string; description?: string; template?: string }) => ({
                      name: typeof item.name === 'string' ? item.name : '',
                      description: typeof item.description === 'string' ? item.description : undefined,
                      template: typeof item.template === 'string' ? item.template : undefined,
                    })).filter((p: { name: string }) => p.name.length > 0));
                  }
                  setSelectedCommand(`prompts:${name}`);
                  onItemSelect?.();
                } catch {
                  // ignore
                }
              }}
              title="Add custom prompt"
            >
              <RiAddLine className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="sm"
              variant="ghost"
              className="h-7 w-7 px-0 -my-1 text-muted-foreground"
              onClick={handleCreateNew}
            >
              <RiAddLine className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {!backendSupportsCommands ? (
        <div className="flex-1 min-h-0">
          <BackendUnsupported
            backendId={selectedBackendId}
            backendLabel={selectedBackend?.label || selectedBackendId}
            featureName={isCodexBackend ? 'Custom Prompts' : 'Commands'}
            comingSoon={selectedBackend?.comingSoon}
          />
        </div>
      ) : isCodexBackend ? (
        <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2">
          {codexPromptsLoading ? (
            <div className="px-4 py-8 text-center typography-micro text-muted-foreground/60">
              Loading prompts...
            </div>
          ) : codexPrompts.filter((p) => p.name.startsWith('prompts:')).length === 0 ? (
            <div className="py-12 px-4 text-center text-muted-foreground">
              <RiTerminalBoxLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
              <p className="typography-ui-label font-medium">No custom prompts found</p>
              <p className="typography-meta mt-1 opacity-75">
                Add <span className="font-mono">.md</span> files to <span className="font-mono">~/.codex/prompts/</span>
              </p>
            </div>
          ) : (
            <>
              {codexPrompts.filter((p) => p.name.startsWith('prompts:')).map((prompt) => {
                const displayName = prompt.name.replace(/^prompts:/, '');
                return (
                  <button
                    key={prompt.name}
                    onClick={() => { setSelectedCommand(prompt.name); onItemSelect?.(); }}
                    className={cn(
                      'flex w-full min-w-0 flex-col gap-0 rounded-md px-1.5 py-1.5 text-left',
                      selectedCommandName === prompt.name ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
                    )}
                  >
                    <span className="typography-ui-label font-normal truncate text-foreground">{displayName}</span>
                    {prompt.description && (
                      <span className="typography-micro text-muted-foreground/60 truncate">{prompt.description}</span>
                    )}
                      </button>
                    );
                  })}
            </>
          )}
        </ScrollableOverlay>
      ) : (
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2">
        {commandOnlyItems.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiTerminalBoxLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">No commands configured</p>
            <p className="typography-meta mt-1 opacity-75">Use the + button above to create one</p>
          </div>
        ) : (
          <>
            {builtInCommands.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Built-in Commands
                </div>
                {[...builtInCommands].sort((a, b) => a.name.localeCompare(b.name)).map((command) => (
                  <CommandListItem
                    key={command.name}
                    command={command}
                    isSelected={selectedCommandName === command.name}
                    onSelect={() => {
                      setSelectedCommand(command.name);
                      onItemSelect?.();

                    }}
                    onReset={() => handleResetCommand(command)}
                    onDuplicate={() => handleDuplicateCommand(command)}
                    isMenuOpen={openMenuCommand === command.name}
                    onMenuOpenChange={(open) => setOpenMenuCommand(open ? command.name : null)}
                  />
                ))}
              </>
            )}

            {customCommands.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Custom Commands
                </div>
                {[...customCommands].sort((a, b) => a.name.localeCompare(b.name)).map((command) => (
                  <CommandListItem
                    key={command.name}
                    command={command}
                    isSelected={selectedCommandName === command.name}
                    onSelect={() => {
                      setSelectedCommand(command.name);
                      onItemSelect?.();

                    }}
                    onRename={() => handleOpenRenameDialog(command)}
                    onDelete={() => handleDeleteCommand(command)}
                    onDuplicate={() => handleDuplicateCommand(command)}
                    isMenuOpen={openMenuCommand === command.name}
                    onMenuOpenChange={(open) => setOpenMenuCommand(open ? command.name : null)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </ScrollableOverlay>
      )}

      <Dialog
        open={confirmActionCommand !== null && confirmActionType !== null}
        onOpenChange={(open) => {
          if (!open && !isConfirmActionPending) {
            closeConfirmActionDialog();
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{confirmActionType === 'delete' ? 'Delete Command' : 'Reset Command'}</DialogTitle>
            <DialogDescription>
              {confirmActionType === 'delete'
                ? `Are you sure you want to delete command "${confirmActionCommand?.name}"?`
                : `Are you sure you want to reset command "${confirmActionCommand?.name}" to its default configuration?`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={closeConfirmActionDialog}
              disabled={isConfirmActionPending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleConfirmAction} disabled={isConfirmActionPending}>
              {confirmActionType === 'delete' ? 'Delete' : 'Reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogCommand !== null} onOpenChange={(open) => !open && setRenameDialogCommand(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Command</DialogTitle>
            <DialogDescription>
              Enter a new name for the command "/{renameDialogCommand?.name}"
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameNewName}
            onChange={(e) => setRenameNewName(e.target.value)}
            placeholder="New command name..."
            className="text-foreground placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRenameCommand();
              }
            }}
          />
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRenameDialogCommand(null)}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleRenameCommand}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface CommandListItemProps {
  command: Command;
  isSelected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  onReset?: () => void;
  onRename?: () => void;
  onDuplicate: () => void;
  isMenuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

const CommandListItem: React.FC<CommandListItemProps> = ({
  command,
  isSelected,
  onSelect,
  onDelete,
  onReset,
  onRename,
  onDuplicate,
  isMenuOpen,
  onMenuOpenChange,
}) => {
  const isMobile = isMobileDeviceViaCSS();
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200 select-none',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
      )}
      onContextMenu={!isMobile ? (e) => {
        e.preventDefault();
        onMenuOpenChange(true);
      } : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          tabIndex={0}
        >
          <div className="flex items-center gap-2">
            <span className="typography-ui-label font-normal truncate text-foreground">
              /{command.name}
            </span>
            {(command.scope || isCommandBuiltIn(command)) && (
              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                {isCommandBuiltIn(command) ? 'system' : command.scope}
              </span>
            )}
          </div>

          {command.description && (
            <div className="typography-micro text-muted-foreground/60 truncate leading-tight">
              {command.description}
            </div>
          )}
        </button>

        <DropdownMenu open={isMenuOpen} onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button size="sm"
              variant="ghost"
              className="h-6 w-6 px-0 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
            >
              <RiMore2Line className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-fit min-w-20">
            {onRename && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onRename();
                }}
              >
                <RiEditLine className="h-4 w-4 mr-px" />
                Rename
              </DropdownMenuItem>
            )}

            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
              }}
            >
              <RiFileCopyLine className="h-4 w-4 mr-px" />
              Duplicate
            </DropdownMenuItem>

            {onReset && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onReset();
                }}
              >
                <RiRestartLine className="h-4 w-4 mr-px" />
                Reset
              </DropdownMenuItem>
            )}

            {onDelete && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="text-destructive focus:text-destructive"
              >
                <RiDeleteBinLine className="h-4 w-4 mr-px" />
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
