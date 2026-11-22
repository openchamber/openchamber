import React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { formatPathForDisplay } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { buildSessionLocationSuggestions, expandSessionLocationInput } from './sessionLocationSuggestions';

/**
 * Picks any folder for a session to continue in. Unlike Move to worktree it
 * resolves nothing about the session's current folder, so it is the way to
 * recover a session whose folder was deleted.
 */
export const ChangeSessionLocationDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentDirectory: string | null;
  onPick: (directory: string) => void;
}> = ({ open, onOpenChange, currentDirectory, onPick }) => {
  const { t } = useI18n();
  const inputId = React.useId();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const [value, setValue] = React.useState('');
  const [currentMissing, setCurrentMissing] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setValue('');
    setCurrentMissing(false);
    if (!currentDirectory) return;
    let cancelled = false;
    void opencodeClient.getDirectoryAvailability(currentDirectory)
      .then((availability) => { if (!cancelled) setCurrentMissing(availability === 'missing'); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [currentDirectory, open]);

  const suggestions = React.useMemo(
    () => (open ? buildSessionLocationSuggestions({ projects, worktreesByProject, currentDirectory }) : []),
    [currentDirectory, open, projects, worktreesByProject],
  );

  const destination = expandSessionLocationInput(value, homeDirectory);
  const submit = () => {
    if (!destination) return;
    onOpenChange(false);
    onPick(destination);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-change-session-location-dialog="true">
        <DialogHeader>
          <DialogTitle>{t('sessions.changeLocation.title')}</DialogTitle>
          <DialogDescription>{t('sessions.changeLocation.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {currentDirectory ? (
            <div className="space-y-0.5">
              <div className="typography-micro text-muted-foreground">{t('sessions.changeLocation.current')}</div>
              <div className="truncate typography-meta text-foreground" title={currentDirectory}>
                {formatPathForDisplay(currentDirectory, homeDirectory)}
              </div>
              {currentMissing ? (
                <div className="typography-micro text-[var(--status-warning)]" data-change-session-location-missing="true">
                  {t('sessions.changeLocation.missing')}
                </div>
              ) : null}
            </div>
          ) : null}

          <form
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label htmlFor={inputId} className="typography-ui-label font-medium text-foreground">
              {t('sessions.changeLocation.field')}
            </label>
            <Input
              id={inputId}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={t('sessions.changeLocation.placeholder')}
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </form>

          {suggestions.length > 0 ? (
            <div className="space-y-1">
              <div className="typography-micro text-muted-foreground">{t('sessions.changeLocation.suggestions')}</div>
              <div className="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.path}
                    type="button"
                    data-change-session-location-suggestion={suggestion.path}
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-[var(--interactive-hover)] focus-visible:bg-[var(--interactive-hover)] focus-visible:outline-none"
                    onClick={() => setValue(suggestion.path)}
                  >
                    <Icon name={suggestion.branch ? 'git-branch' : 'folder'} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                      {suggestion.branch ?? suggestion.label}
                    </span>
                    <span className="min-w-0 max-w-[50%] truncate typography-micro text-muted-foreground">
                      {formatPathForDisplay(suggestion.path, homeDirectory)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('sessions.changeLocation.cancel')}</Button>
          <Button onClick={submit} disabled={!destination} data-change-session-location-confirm="true">
            {t('sessions.changeLocation.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
