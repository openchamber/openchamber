import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSessionStore } from '@/stores/useSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getProjectDirectoryOptions } from '@/lib/worktrees/projectDirectories';

export interface KanbanCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: { title: string; description: string; worktreeId: string }) => void | Promise<void>;
  mode: 'create' | 'edit';
  initialData?: {
    title?: string;
    description?: string;
    worktreeId?: string;
  };
  onDelete?: () => void | Promise<void>;
  status?: string;
  sessionId?: string;
}

export const KanbanCardDialog: React.FC<KanbanCardDialogProps> = ({
  open,
  onOpenChange,
  onSave,
  mode,
  initialData,
  onDelete,
  status,
  sessionId,
}) => {
  const { currentTheme } = useThemeSystem();
  const availableWorktreesByProject = useSessionStore(
    (state) => state.availableWorktreesByProject
  );
  const getActiveProject = useProjectsStore((state) => state.getActiveProject);

  const [title, setTitle] = React.useState(initialData?.title ?? '');
  const [description, setDescription] = React.useState(initialData?.description ?? '');
  const [worktreeId, setWorktreeId] = React.useState(initialData?.worktreeId ?? '');
  const [isPending, setIsPending] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setTitle(initialData?.title ?? '');
      setDescription(initialData?.description ?? '');
      setWorktreeId(initialData?.worktreeId ?? '');
      setIsPending(false);
    }
  }, [open, initialData]);

  const activeProject = getActiveProject();
  const directoryOptions = React.useMemo(
    () => getProjectDirectoryOptions(
      activeProject?.path ?? null,
      availableWorktreesByProject
    ),
    [activeProject?.path, availableWorktreesByProject]
  );

  const hasWorktrees = directoryOptions.length > 0;
  const isValid = title.trim().length > 0 && description.trim().length > 0 && worktreeId.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isValid && !isPending) {
      setIsPending(true);
      try {
        await onSave({
          title: title.trim(),
          description: description.trim(),
          worktreeId: worktreeId.trim(),
        });
      } finally {
        setIsPending(false);
      }
    }
  };

  const handleDelete = async () => {
    if (onDelete && !isPending) {
      setIsPending(true);
      try {
        await onDelete();
      } finally {
        setIsPending(false);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isPending && !nextOpen) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create Card' : 'Edit Card'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="card-title"
              className="typography-ui-label text-foreground"
            >
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              id="card-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Card title"
              autoFocus
            />
          </div>

          {mode === 'edit' && (status || sessionId) && (
            <div
              className="space-y-2 p-3 rounded-md"
              style={{
                backgroundColor: currentTheme.colors.surface.elevated,
                border: `1px solid ${currentTheme.colors.interactive.border}`
              }}
            >
              <label
                className="typography-ui-label text-xs uppercase tracking-wider"
                style={{ color: currentTheme.colors.surface.mutedForeground }}
              >
                Automation Context
              </label>
              {status && (
                <div className="flex justify-between items-center">
                  <span
                    className="typography-ui-label"
                    style={{ color: currentTheme.colors.surface.foreground }}
                  >
                    Status
                  </span>
                  <span
                    className="typography-mono text-xs"
                    style={{ color: currentTheme.colors.surface.mutedForeground }}
                  >
                    {status}
                  </span>
                </div>
              )}
              {sessionId && (
                <div className="flex justify-between items-center">
                  <span
                    className="typography-ui-label"
                    style={{ color: currentTheme.colors.surface.foreground }}
                  >
                    Session ID
                  </span>
                  <span
                    className="typography-mono text-xs"
                    style={{ color: currentTheme.colors.surface.mutedForeground }}
                  >
                    {sessionId}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor="card-description"
              className="typography-ui-label text-foreground"
            >
              Description <span className="text-destructive">*</span>
            </label>
            <Textarea
              id="card-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Card description"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <label
              htmlFor="card-worktree"
              className="typography-ui-label text-foreground"
            >
              Worktree <span className="text-destructive">*</span>
            </label>
            <Select
              value={worktreeId}
              onValueChange={setWorktreeId}
              disabled={!hasWorktrees}
            >
              <SelectTrigger id="card-worktree" className="w-full">
                <SelectValue placeholder="Select a worktree" />
              </SelectTrigger>
              <SelectContent>
                {hasWorktrees ? (
                  directoryOptions.map((option) => (
                    <SelectItem key={option.path} value={option.path}>
                      {option.label}
                    </SelectItem>
                  ))
                ) : null}
              </SelectContent>
            </Select>
            {!hasWorktrees && (
              <p
                className="typography-micro text-muted-foreground"
                style={{ color: currentTheme.colors.status.warning }}
              >
                No worktrees available for this project
              </p>
            )}
          </div>

          <DialogFooter>
            {mode === 'edit' && onDelete && (
              <Button
                type="button"
                variant="destructive"
                onClick={handleDelete}
                disabled={isPending}
              >
                Delete
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || !hasWorktrees || isPending}>
              {mode === 'create' ? 'Create' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
