import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { buildForgeProvider } from '@/lib/forge/adapters';
import { useI18n } from '@/lib/i18n';
import { buildLinkedIssue, parseForgeEntityUrl } from '@/lib/linkedIssues';
import { setLinkedIssue } from '@/sync/session-actions';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  directory: string | null;
};

/**
 * Manual "link this issue/PR" control for the context-sources section.
 *
 * The URL is parsed first (`parseForgeEntityUrl`) and validated against the
 * forge before the link is recorded: the live fetch proves the entity exists
 * and supplies its real title, so a stale or mistyped URL surfaces as a
 * `linkFailed` toast instead of a snapshot row that never resolves. Linking
 * rides the same `setLinkedIssue`/session-metadata channel as the attach
 * flows, so the row appears through the section's existing session read.
 */
export const WorkStatusLinkDialog: React.FC<Props> = ({ open, onOpenChange, sessionId, directory }) => {
  const { t } = useI18n();
  const [url, setUrl] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const handleOpenChange = React.useCallback((next: boolean) => {
    if (!next) {
      setUrl('');
      setError(null);
      setBusy(false);
    }
    onOpenChange(next);
  }, [onOpenChange]);

  const handleLink = React.useCallback(async () => {
    if (!sessionId || !directory || busy) return;

    const parsed = parseForgeEntityUrl(url);
    if (!parsed) {
      setError(t('chat.workStatus.linkedIssues.linkInvalid'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const apis = getRegisteredRuntimeAPIs();
      const provider = apis ? buildForgeProvider(parsed.provider, apis) : null;
      if (!provider) {
        toast.error(t('chat.workStatus.linkedIssues.linkFailed'));
        return;
      }

      // Validate the entity exists on the forge and grab its real title. The
      // facade resolves the repo from the session's remotes; an entity the
      // forge no longer knows (or a repo the session cannot reach) reports no
      // title and the link is refused.
      let title: string | null = null;
      try {
        if (parsed.kind === 'pull') {
          const context = await provider.getPullRequestContext(directory, parsed.number);
          title = context.pr?.title ?? null;
        } else {
          const detail = await provider.getIssue(directory, parsed.number);
          title = detail.issue?.title ?? null;
        }
      } catch {
        title = null;
      }
      if (!title) {
        toast.error(t('chat.workStatus.linkedIssues.linkFailed'));
        return;
      }

      const issue = buildLinkedIssue({
        url: url.trim(),
        number: parsed.number,
        title,
        kind: parsed.kind,
        provider: parsed.provider,
        repo: parsed.repo,
        linkedAt: Date.now(),
      });
      await setLinkedIssue(sessionId, directory, issue, true);
      toast.success(t('chat.workStatus.linkedIssues.linked'));
      handleOpenChange(false);
    } catch {
      toast.error(t('chat.workStatus.linkedIssues.linkFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, directory, handleOpenChange, sessionId, t, url]);

  const canSubmit = Boolean(sessionId && directory) && !busy && url.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat.workStatus.linkedIssues.linkDialogTitle')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t('chat.workStatus.linkedIssues.linkPlaceholder')}
            aria-invalid={error ? true : undefined}
            disabled={busy || !sessionId || !directory}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) void handleLink();
            }}
          />
          {error ? <p className="text-xs text-[var(--status-error)]">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button onClick={() => void handleLink()} disabled={!canSubmit}>
            {busy ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
            {t('chat.workStatus.linkedIssues.link')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
