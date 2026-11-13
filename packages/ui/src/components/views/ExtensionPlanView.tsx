import React from 'react';
import { EditorView } from '@codemirror/view';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { captureDefaultSendSelection } from '@/lib/defaultSendSelection';
import { guestMay } from '@/lib/guests/capabilities';
import { readGuestPlanFile, writeGuestPlanFile } from '@/lib/guests/plans/api';
import {
  planGuestPlanAction,
  runGuestPlanAction,
  type GuestPlanActionOutcome,
  type GuestPlanActionPlan,
} from '@/lib/guests/plans/actions';
import { findGuestPlanProvider, guestPlanCatalogKey, refreshGuestPlanCatalog, useGuestPlanCatalogStore } from '@/lib/guests/plans/catalog';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { ExtensionPlanStatus } from '@/components/session/project-context/ExtensionPlansSection';
import type { ExtensionPlanSelection } from '@/lib/guests/plans/selection';

/** How often an open plan checks its file for changes made elsewhere. */
const FILE_POLL_MS = 2_000;

type PlanFile =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed'; message: string }
  /** `base` and `hash` are what is on disk as far as this view knows; `draft` is the editor. */
  | { state: 'ready'; base: string; hash: string; draft: string; gone?: true };

type Conflict = { hash: string | null } | null;

const outcomeMessage = (
  outcome: Exclude<GuestPlanActionOutcome, { ok: true }>,
  confirmed: GuestPlanActionPlan,
  extension: string,
  t: (key: I18nKey, params?: I18nParams) => string,
): string => {
  if (outcome.stage === 'create') return t('extensionPlans.outcome.createFailed');
  if (outcome.stage === 'send') return t('extensionPlans.outcome.sendFailed', { message: outcome.message });
  const invocation = confirmed.invocation;
  switch (outcome.reason) {
    case 'extension-unavailable': return t('extensionPlans.outcome.extensionUnavailable', { extension });
    case 'action-changed': return t('extensionPlans.outcome.actionChanged');
    case 'plan-changed': return t('extensionPlans.outcome.planChanged');
    case 'plan-unreadable': return t('extensionPlans.outcome.planUnreadable');
    case 'command-missing': return t('extensionPlans.outcome.commandMissing', { name: invocation.type === 'command' ? invocation.name : '' });
    case 'skill-missing': return t('extensionPlans.outcome.skillMissing', { name: invocation.type === 'skill' ? invocation.name : '' });
    case 'agent-missing': return t('extensionPlans.outcome.agentMissing', { name: invocation.agent ?? '' });
    case 'lookup-failed': return t('extensionPlans.outcome.lookupFailed');
    case 'no-model': return t('extensionPlans.outcome.noModel');
    case 'runtime-changed': return t('extensionPlans.outcome.runtimeChanged');
  }
};

const ConfirmRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="space-y-0.5">
    <div className="typography-micro text-muted-foreground">{label}</div>
    <div className="typography-meta break-all text-foreground">{children}</div>
  </div>
);

/**
 * A plan another tool keeps in the worktree, opened from the Plans area. The
 * file itself is the document: it is read from and written back to its own
 * path, a save that would overwrite a change made elsewhere stops and asks,
 * and the only ways to start work on it are the extension's declared actions,
 * each confirmed with exactly what will run.
 */
export const ExtensionPlanView: React.FC<{
  selection: ExtensionPlanSelection;
  visible?: boolean;
  leading?: React.ReactNode;
  onNavigatedToChat?: () => void;
}> = ({ selection, visible = true, leading, onNavigatedToChat }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const editorFontSize = useUIStore((state) => state.editorFontSize);
  const { guestId, providerId, directory, path } = selection;
  const guest = useGuestsStore((state) => state.guests.find((entry) => entry.id === guestId) ?? null);
  const provider = findGuestPlanProvider(guest, providerId);
  const catalogKey = guest ? guestPlanCatalogKey(guest, selection) : null;
  const catalog = useGuestPlanCatalogStore((state) => (catalogKey ? state.catalogs[catalogKey] : undefined));
  const entry = catalog?.status === 'ready' ? catalog.plans.find((plan) => plan.path === path) ?? null : null;

  const [file, setFile] = React.useState<PlanFile>({ state: 'loading' });
  const [conflict, setConflict] = React.useState<Conflict>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<'preview' | 'edit'>('preview');
  const [pendingAction, setPendingAction] = React.useState<GuestPlanActionPlan | null>(null);
  const [running, setRunning] = React.useState(false);
  const fileRef = React.useRef(file);
  fileRef.current = file;
  const savingRef = React.useRef(false);

  const dirty = file.state === 'ready' && file.draft !== file.base;

  const applyRead = React.useCallback((read: Awaited<ReturnType<typeof readGuestPlanFile>>) => {
    if (read.ok) {
      setFile({ state: 'ready', base: read.result.content, hash: read.result.hash, draft: read.result.content });
      setConflict(null);
      return;
    }
    setFile(read.code === 'NOT_FOUND' ? { state: 'missing' } : { state: 'failed', message: read.message });
  }, []);

  // Each opened plan is its own document: a different worktree with a plan of
  // the same name is a different file and starts from a fresh read.
  React.useEffect(() => {
    let cancelled = false;
    setFile({ state: 'loading' });
    setConflict(null);
    setSaveError(null);
    void readGuestPlanFile(guestId, providerId, directory, path).then((read) => {
      if (!cancelled) applyRead(read);
    });
    return () => { cancelled = true; };
  }, [applyRead, directory, guestId, path, providerId]);

  // Changes made elsewhere (the tool itself, an agent, another editor): taken
  // as they are while nothing is typed here, reported as a conflict otherwise.
  React.useEffect(() => {
    if (!visible || file.state !== 'ready') return;
    let polling = false;
    let cancelled = false;
    const poll = async () => {
      if (polling || savingRef.current || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        const read = await readGuestPlanFile(guestId, providerId, directory, path);
        const current = fileRef.current;
        if (cancelled || savingRef.current || current.state !== 'ready') return;
        if (!read.ok) {
          // Unsaved edits survive the file disappearing: they may be the only copy.
          if (read.code === 'NOT_FOUND') setFile(current.draft === current.base ? { state: 'missing' } : { ...current, gone: true });
          return;
        }
        if (current.gone) {
          setFile({ ...current, gone: undefined });
          setConflict({ hash: read.result.hash });
          return;
        }
        if (read.result.hash === current.hash) return;
        if (current.draft === current.base) {
          setFile({ state: 'ready', base: read.result.content, hash: read.result.hash, draft: read.result.content });
          void refreshGuestPlanCatalog({ guestId, providerId, directory });
        } else {
          setConflict({ hash: read.result.hash });
        }
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => { void poll(); }, FILE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [directory, file.state, guestId, path, providerId, visible]);

  const write = React.useCallback(async (expectedHash: string) => {
    const current = fileRef.current;
    if (current.state !== 'ready' || savingRef.current) return;
    const content = current.draft;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const written = await writeGuestPlanFile(guestId, providerId, directory, path, content, expectedHash);
      if (written.ok) {
        setFile((latest) => (latest.state === 'ready'
          ? { state: 'ready', base: content, hash: written.result.hash, draft: latest.draft }
          : latest));
        setConflict(null);
        // The extension's description (progress, status) follows the new text.
        void refreshGuestPlanCatalog({ guestId, providerId, directory });
        return;
      }
      if (written.code === 'CONFLICT') {
        setConflict({ hash: written.hash ?? null });
        return;
      }
      if (written.code === 'NOT_FOUND') {
        setFile((latest) => (latest.state === 'ready' ? { ...latest, gone: true } : latest));
        return;
      }
      setSaveError(written.message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [directory, guestId, path, providerId]);

  const save = React.useCallback(() => {
    const current = fileRef.current;
    if (current.state === 'ready' && current.draft !== current.base && !conflict && !current.gone) void write(current.hash);
  }, [conflict, write]);

  const reloadFromDisk = React.useCallback(async () => {
    applyRead(await readGuestPlanFile(guestId, providerId, directory, path));
  }, [applyRead, directory, guestId, path, providerId]);

  const overwrite = React.useCallback(() => {
    if (conflict?.hash) void write(conflict.hash);
    else void reloadFromDisk();
  }, [conflict, reloadFromDisk, write]);

  const discard = React.useCallback(() => {
    setFile((current) => (current.state !== 'ready' ? current : current.gone ? { state: 'missing' } : { ...current, draft: current.base }));
    setConflict(null);
  }, []);

  const editorExtensions = React.useMemo(() => {
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, { fontSize: editorFontSize })];
    const language = languageByExtension(path);
    if (language) extensions.push(language);
    extensions.push(EditorView.lineWrapping);
    return extensions;
  }, [currentTheme, editorFontSize, path]);

  const extension = guest?.name ?? guestId;
  const actionsAllowed = guestMay(guest, 'plans');
  const described = catalog?.status === 'ready' && catalog.description.state === 'ready';
  const actions = provider?.actions ?? [];
  const actionsBlockedReason = !actionsAllowed
    ? t('extensionPlans.view.actions.paused', { extension })
    : dirty || conflict || (file.state === 'ready' && file.gone)
      ? t('extensionPlans.view.actions.dirty')
      : !described || !entry
        ? t('extensionPlans.view.actions.undescribed', { extension })
        : null;

  const askToRun = React.useCallback((actionId: string) => {
    const current = fileRef.current;
    if (current.state !== 'ready') return;
    const planned = planGuestPlanAction({ guestId, providerId, actionId, directory, path, hash: current.hash });
    if (planned) setPendingAction(planned);
  }, [directory, guestId, path, providerId]);

  const confirmRun = React.useCallback(async () => {
    const confirmed = pendingAction;
    if (!confirmed || running) return;
    setRunning(true);
    try {
      const outcome = await runGuestPlanAction(confirmed);
      setPendingAction(null);
      if (outcome.ok) {
        toast.success(t('extensionPlans.outcome.started', { action: confirmed.action.label }));
        onNavigatedToChat?.();
        return;
      }
      if (outcome.stage === 'send') onNavigatedToChat?.();
      toast.error(outcomeMessage(outcome, confirmed, extension, t));
    } finally {
      setRunning(false);
    }
  }, [extension, onNavigatedToChat, pendingAction, running, t]);

  const selectionForDialog = pendingAction ? captureDefaultSendSelection() : null;
  const title = entry?.title ?? path.slice(path.lastIndexOf('/') + 1);

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          save();
        }
      }}
    >
      <div className="flex min-w-0 flex-shrink-0 items-center gap-2 border-b border-border/40 px-3 py-1.5">
        {leading}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="typography-ui-label font-medium truncate" dir="auto">{title}</span>
            {entry ? <ExtensionPlanStatus plan={entry} /> : null}
            {entry?.progress && entry.progress.total > 0 ? (
              <span className="shrink-0 typography-micro tabular-nums text-muted-foreground" title={t('extensionPlans.progress.title', entry.progress)}>
                {`${entry.progress.done}/${entry.progress.total}`}
              </span>
            ) : null}
          </div>
          <div className="typography-micro text-muted-foreground truncate" title={`${directory}/${path}`}>
            {t('extensionPlans.view.source', { provider: provider?.label ?? providerId, path })}
          </div>
        </div>
        {file.state === 'ready' ? (
          <div className="flex shrink-0 items-center gap-1">
            {dirty ? (
              <>
                <Button variant="ghost" size="xs" onClick={discard} disabled={saving}>{t('extensionPlans.view.discard')}</Button>
                <Button size="xs" onClick={save} disabled={saving || Boolean(conflict) || file.gone === true}>
                  {saving ? <Spinner className="size-3" /> : null}
                  {saving ? t('extensionPlans.view.saving') : t('extensionPlans.view.save')}
                </Button>
              </>
            ) : null}
            {actions.length > 0 ? (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-5 w-5 p-0" aria-label={t('extensionPlans.view.actions')} disabled={Boolean(actionsBlockedReason)}>
                        <Icon name="play" className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={8}>{actionsBlockedReason ?? t('extensionPlans.view.actions')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end">
                  {actions.map((action) => {
                    const applies = entry?.actions.includes(action.id) ?? false;
                    return (
                      <DropdownMenuItem key={action.id} disabled={!applies} onClick={() => askToRun(action.id)}>
                        <span>{action.label}</span>
                        {!applies ? <span className="ms-auto ps-3 typography-micro text-muted-foreground">{t('extensionPlans.view.actions.notApplicable')}</span> : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={t('documentToolbar.preview')} aria-pressed={mode === 'preview'}
                  onClick={() => setMode(mode === 'preview' ? 'edit' : 'preview')}>
                  <Icon name="eye" className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={8}>{t('documentToolbar.preview')}</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>

      {conflict ? (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 bg-[var(--status-warning)]/12 px-3 py-2">
          <p className="min-w-0 flex-1 typography-meta text-foreground">{t('extensionPlans.view.conflict')}</p>
          <Button variant="outline" size="xs" onClick={() => void reloadFromDisk()} disabled={saving}>{t('extensionPlans.view.conflict.reload')}</Button>
          <Button size="xs" onClick={overwrite} disabled={saving}>{t('extensionPlans.view.conflict.overwrite')}</Button>
        </div>
      ) : null}
      {file.state === 'ready' && file.gone ? (
        <p className="flex-shrink-0 bg-[var(--status-warning)]/12 px-3 py-2 typography-meta text-foreground">{t('extensionPlans.view.goneWithEdits')}</p>
      ) : null}
      {saveError ? (
        <p className="flex-shrink-0 bg-[var(--status-error)]/12 px-3 py-2 typography-meta text-foreground">{t('extensionPlans.view.saveFailed', { message: saveError })}</p>
      ) : null}

      <div className="relative min-h-0 min-w-0 flex-1">
        {file.state === 'loading' ? (
          <div className="p-3 typography-ui text-muted-foreground">{t('planView.state.loading')}</div>
        ) : file.state === 'missing' ? (
          <div className="p-3 typography-meta text-muted-foreground">{t('extensionPlans.view.missing')}</div>
        ) : file.state === 'failed' ? (
          <div className="p-3 typography-meta text-[var(--status-error)]">{t('extensionPlans.view.openFailed', { message: file.message })}</div>
        ) : mode === 'preview' ? (
          <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0 p-3">
            <ErrorBoundary fallback={<div className="typography-meta text-muted-foreground">{t('planView.error.switchToEditMode')}</div>}>
              <SimpleMarkdownRenderer content={file.draft} className="typography-markdown-body" frontmatter="properties" enableFileReferences={false} />
            </ErrorBoundary>
          </ScrollableOverlay>
        ) : (
          <CodeMirrorEditor
            value={file.draft}
            onChange={(next) => setFile((current) => (current.state === 'ready' && next !== current.draft ? { ...current, draft: next } : current))}
            readOnly={false}
            className="h-full"
            extensions={editorExtensions}
          />
        )}
      </div>

      <Dialog open={pendingAction !== null} onOpenChange={(open) => { if (!open && !running) setPendingAction(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('extensionPlans.confirm.title', { action: pendingAction?.action.label ?? '' })}</DialogTitle>
            <DialogDescription>{t('extensionPlans.confirm.description', { extension })}</DialogDescription>
          </DialogHeader>
          {pendingAction ? (
            <div className="space-y-3">
              <ConfirmRow label={t('extensionPlans.confirm.plan')}><span className="font-mono">{path}</span></ConfirmRow>
              <ConfirmRow label={t('extensionPlans.confirm.worktree')}>
                <span title={directory}>{formatDirectoryName(directory) || directory}</span>
              </ConfirmRow>
              <ConfirmRow
                label={pendingAction.invocation.type === 'command'
                  ? t('extensionPlans.confirm.command')
                  : pendingAction.invocation.type === 'skill'
                    ? t('extensionPlans.confirm.skill', { name: pendingAction.invocation.name })
                    : t('extensionPlans.confirm.prompt')}
              >
                <pre className="whitespace-pre-wrap rounded-md bg-[var(--surface-muted)] px-2 py-1.5 font-mono typography-meta">
                  {pendingAction.invocation.type === 'command'
                    ? `/${pendingAction.invocation.name}${pendingAction.invocation.arguments ? ` ${pendingAction.invocation.arguments}` : ''}`
                    : pendingAction.invocation.text}
                </pre>
              </ConfirmRow>
              <ConfirmRow label={t('extensionPlans.confirm.agent')}>
                {pendingAction.invocation.agent ?? t('extensionPlans.confirm.agentDefault')}
              </ConfirmRow>
              <ConfirmRow label={t('extensionPlans.confirm.model')}>
                {selectionForDialog
                  ? `${selectionForDialog.providerID}/${selectionForDialog.modelID}`
                  : <span className="text-[var(--status-error)]">{t('extensionPlans.confirm.modelMissing')}</span>}
              </ConfirmRow>
            </div>
          ) : null}
          <DialogFooter>
            <Button size="sm" variant="ghost" disabled={running} onClick={() => setPendingAction(null)}>{t('extensionPlans.confirm.cancel')}</Button>
            <Button size="sm" disabled={running || !selectionForDialog} onClick={() => void confirmRun()}>
              {running ? <Spinner className="size-3" /> : null}
              {t('extensionPlans.confirm.start')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
