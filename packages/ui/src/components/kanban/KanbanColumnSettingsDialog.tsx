import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigStore } from '@/stores/useConfigStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import type { BoardColumn, BoardColumnAutomation } from '@/types/kanban';
import { RiArrowRightLine } from '@remixicon/react';

export interface KanbanColumnSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  column: BoardColumn;
  columns: BoardColumn[];
  initialAutomation?: BoardColumnAutomation | null;
  onSave: (automation: BoardColumnAutomation | null) => void | Promise<void>;
}

const NO_MOVE_TARGET_VALUE = '__none__';

export const KanbanColumnSettingsDialog: React.FC<KanbanColumnSettingsDialogProps> = ({
  open,
  onOpenChange,
  column,
  columns,
  initialAutomation,
  onSave,
}) => {
  const { currentTheme } = useThemeSystem();
  const providers = useConfigStore((state) => state.providers);

  const [onEnterText, setOnEnterText] = React.useState('');
  const [agent, setAgent] = React.useState('');
  const [providerId, setProviderId] = React.useState('');
  const [modelId, setModelId] = React.useState('');
  const [variant, setVariant] = React.useState('');
  const [onFinishMoveTo, setOnFinishMoveTo] = React.useState<string>('');
  const [isPending, setIsPending] = React.useState(false);

  const selectedModel = React.useMemo(() => {
    const provider = providers.find((p) => p.id === providerId);
    return provider?.models.find((m) => m.id === modelId);
  }, [providers, providerId, modelId]);

  const modelVariants = React.useMemo(() => {
    if (!selectedModel) return [];
    const variants = (selectedModel as { variants?: Record<string, unknown> })?.variants;
    if (!variants) return [];
    return Object.keys(variants);
  }, [selectedModel]);

  const hasVariants = modelVariants.length > 0;

  const isValid = React.useMemo(() => {
    if (!onEnterText.trim()) return false;
    if (!agent.trim()) return false;
    if (!providerId.trim()) return false;
    if (!modelId.trim()) return false;
    if (hasVariants && !variant.trim()) return false;
    return true;
  }, [onEnterText, agent, providerId, modelId, variant, hasVariants]);

  const onFinishMoveToValidation = React.useMemo(() => {
    if (!onFinishMoveTo.trim()) {
      return null;
    }
    if (onFinishMoveTo === column.id) {
      return 'Cannot move to the same column';
    }
    const exists = columns.some((c) => c.id === onFinishMoveTo);
    if (!exists) {
      return 'Column does not exist';
    }
    return null;
  }, [onFinishMoveTo, column.id, columns]);

  const otherColumns = React.useMemo(() => {
    return columns.filter((c) => c.id !== column.id);
  }, [columns, column.id]);

  const handleSave = async () => {
    if (isValid && !isPending) {
      setIsPending(true);
      try {
        await onSave({
          onEnterText: onEnterText.trim(),
          agent: agent.trim(),
          providerID: providerId.trim(),
          modelID: modelId.trim(),
          variant: variant.trim() || undefined,
          onFinishMoveTo: onFinishMoveTo.trim() || undefined,
        });
        onOpenChange(false);
      } finally {
        setIsPending(false);
      }
    }
  };

  const handleDisable = async () => {
    if (!isPending) {
      setIsPending(true);
      try {
        await onSave(null);
        onOpenChange(false);
      } finally {
        setIsPending(false);
      }
    }
  };

  React.useEffect(() => {
    if (open) {
      setOnEnterText(initialAutomation?.onEnterText ?? '');
      setAgent(initialAutomation?.agent ?? '');
      setProviderId(initialAutomation?.providerID ?? '');
      setModelId(initialAutomation?.modelID ?? '');
      setVariant(initialAutomation?.variant ?? '');
      setOnFinishMoveTo(initialAutomation?.onFinishMoveTo ?? '');
      setIsPending(false);
    }
  }, [open, initialAutomation]);

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
          <DialogTitle>Column Automation</DialogTitle>
          <DialogDescription>
            Configure automated tasks for cards moved to &quot;{column.name}&quot;
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="onEnterText"
              className="typography-ui-label text-foreground"
            >
              Auto-run prompt <span className="text-destructive">*</span>
            </label>
            <Input
              id="onEnterText"
              value={onEnterText}
              onChange={(e) => setOnEnterText(e.target.value)}
              placeholder="Enter task description..."
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="typography-ui-label text-foreground">
              Agent <span className="text-destructive">*</span>
            </label>
            <AgentSelector
              agentName={agent}
              onChange={setAgent}
              className="w-full"
            />
          </div>

          <div className="space-y-2">
            <label className="typography-ui-label text-foreground">
              Provider/Model <span className="text-destructive">*</span>
            </label>
            <ModelSelector
              providerId={providerId}
              modelId={modelId}
              onChange={(newProviderId: string, newModelId: string) => {
                setProviderId(newProviderId);
                setModelId(newModelId);
                setVariant('');
              }}
              className="w-full"
            />
          </div>

          {hasVariants && (
            <div className="space-y-2">
              <label htmlFor="variant" className="typography-ui-label text-foreground">
                Variant <span className="text-destructive">*</span>
              </label>
              <Select value={variant} onValueChange={setVariant}>
                <SelectTrigger id="variant" className="w-full">
                  <SelectValue placeholder="Select variant" />
                </SelectTrigger>
                <SelectContent>
                  {modelVariants.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {otherColumns.length > 0 && (
            <div className="space-y-2">
              <label htmlFor="onFinishMoveTo" className="typography-ui-label text-foreground">
                Auto-move to column
              </label>
              <div className="flex items-center gap-2">
                <Select
                  value={onFinishMoveTo || NO_MOVE_TARGET_VALUE}
                  onValueChange={(value) => {
                    setOnFinishMoveTo(value === NO_MOVE_TARGET_VALUE ? '' : value);
                  }}
                >
                  <SelectTrigger id="onFinishMoveTo" className="flex-1">
                    <SelectValue placeholder="Don't move" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_MOVE_TARGET_VALUE}>Don't move</SelectItem>
                    {otherColumns.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div
                  className="flex items-center gap-1 typography-micro text-muted-foreground"
                  style={{ color: currentTheme.colors.surface.mutedForeground }}
                >
                  after completion
                </div>
              </div>
              {onFinishMoveToValidation && (
                <p
                  className="typography-micro"
                  style={{ color: currentTheme.colors.status.error }}
                >
                  {onFinishMoveToValidation}
                </p>
              )}
            </div>
          )}

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
              Preview
            </label>
            <div
              className="typography-ui-label"
              style={{ color: currentTheme.colors.surface.foreground }}
            >
              When a card enters &quot;{column.name}&quot;:
            </div>
            <div className="flex items-start gap-2">
              <div
                className="flex items-center justify-center flex-shrink-0 w-6 h-6 rounded-full text-xs font-medium"
                style={{
                  backgroundColor: currentTheme.colors.primary.base,
                  color: currentTheme.colors.primary.foreground
                }}
              >
                AI
              </div>
              <div className="flex-1 space-y-1">
                {agent && (
                  <div
                    className="typography-micro"
                    style={{ color: currentTheme.colors.surface.mutedForeground }}
                  >
                    Using agent: {agent}
                  </div>
                )}
                {providerId && modelId && (
                  <div
                    className="typography-micro"
                    style={{ color: currentTheme.colors.surface.mutedForeground }}
                  >
                    Model: {providerId}/{modelId}
                    {hasVariants && variant && ` (${variant})`}
                  </div>
                )}
                {onEnterText && (
                  <div
                    className="typography-ui-label"
                    style={{ color: currentTheme.colors.surface.foreground }}
                  >
                    {onEnterText}
                  </div>
                )}
              </div>
            </div>
            {onFinishMoveTo && (
              <div className="flex items-center gap-2 mt-2">
                <RiArrowRightLine
                  className="flex-shrink-0"
                  style={{ color: currentTheme.colors.interactive.border }}
                />
                <span
                  className="typography-ui-label"
                  style={{ color: currentTheme.colors.surface.foreground }}
                >
                  Move to &quot;{columns.find((c) => c.id === onFinishMoveTo)?.name}&quot;
                </span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          {initialAutomation && (
            <Button
              type="button"
              variant="outline"
              onClick={handleDisable}
              disabled={isPending}
            >
              Disable Automation
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
          <Button type="button" disabled={!isValid || !!onFinishMoveToValidation || isPending} onClick={handleSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
