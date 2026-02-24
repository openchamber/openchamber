import React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ButtonLarge } from '@/components/ui/button-large';
import { ButtonSmall } from '@/components/ui/button-small';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';

export type SkillConflict = {
  skillName: string;
  scope: 'user' | 'project';
  source?: 'opencode' | 'agents';
};

export type ConflictDecision = 'skip' | 'overwrite';

interface InstallConflictsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflicts: SkillConflict[];
  onConfirm: (decisions: Record<string, ConflictDecision>) => void;
}

export const InstallConflictsDialog: React.FC<InstallConflictsDialogProps> = ({
  open,
  onOpenChange,
  conflicts,
  onConfirm,
}) => {
  const [decisions, setDecisions] = React.useState<Record<string, ConflictDecision>>({});

  React.useEffect(() => {
    if (!open) return;
    const initial: Record<string, ConflictDecision> = {};
    for (const conflict of conflicts) {
      initial[conflict.skillName] = 'skip';
    }
    setDecisions(initial);
  }, [open, conflicts]);

  const setAll = (decision: ConflictDecision) => {
    const next: Record<string, ConflictDecision> = {};
    for (const conflict of conflicts) {
      next[conflict.skillName] = decision;
    }
    setDecisions(next);
  };

  const canConfirm = conflicts.length > 0 && conflicts.every((c) => decisions[c.skillName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Skills already exist</DialogTitle>
          <DialogDescription>
            Some selected skills are already installed in this scope. Choose whether to skip or overwrite them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="typography-meta text-muted-foreground">{conflicts.length} conflict(s)</span>
            <div className="flex items-center gap-2">
              <ButtonSmall variant="outline" size="xs" className="!font-normal" onClick={() => setAll('skip')}>Skip all</ButtonSmall>
              <ButtonSmall variant="outline" size="xs" className="!font-normal" onClick={() => setAll('overwrite')}>Overwrite all</ButtonSmall>
            </div>
          </div>

          <div className="space-y-2">
            {conflicts.map((conflict) => (
              <div
                key={conflict.skillName}
                className="flex items-center justify-between gap-3 py-1.5"
              >
                <div className="min-w-0">
                  <div className="typography-ui-label truncate">{conflict.skillName}</div>
                  <div className="typography-micro text-muted-foreground">
                    Installed in {conflict.scope} / {conflict.source || 'opencode'}
                  </div>
                </div>

                <Select
                  value={decisions[conflict.skillName] || 'skip'}
                  onValueChange={(v) => setDecisions((prev) => ({ ...prev, [conflict.skillName]: v as ConflictDecision }))}
                >
                  <SelectTrigger className="w-fit">
                    <span className="capitalize">{decisions[conflict.skillName] || 'skip'}</span>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="skip" className="pr-2 [&>span:first-child]:hidden">
                      Skip
                    </SelectItem>
                    <SelectItem value="overwrite" className="pr-2 [&>span:first-child]:hidden">
                      Overwrite
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <ButtonLarge variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </ButtonLarge>
          <ButtonLarge
            onClick={() => onConfirm(decisions)}
            disabled={!canConfirm}
          >
            Continue
          </ButtonLarge>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
