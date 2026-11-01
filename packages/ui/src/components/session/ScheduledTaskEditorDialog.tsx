import * as React from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '@/components/chat/CommandAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '@/components/chat/FileMentionAutocomplete';
import { SnippetAutocomplete, type SnippetAutocompleteHandle } from '@/components/chat/SnippetAutocomplete';
import { Icon } from "@/components/icon/Icon";
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';
import { fetchEligibleScheduledTaskTargets } from '@/lib/scheduledTasksApi';
import { BranchSelector, useBranchOptions } from '@/components/multirun/BranchSelector';
// Draft shape and payload building live in scheduledTaskEditorDraft.ts so they
// can be unit-tested without mounting the dialog.
import {
  buildScheduledTaskPayload,
  toDraft,
  validateDraft,
  type ScheduledTaskDraft,
} from './scheduledTaskEditorDraft';
import { useI18n } from '@/lib/i18n';
import { isValidCronExpression, getNextRuns, CRON_EXAMPLES } from '@/lib/cron';
import { canonicalizeTimezone } from '@/lib/timezones';
import { listModelVariantIds, type ModelVariantSource } from '@/lib/modelVariants';
import { useGlobalSessionsStore, refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { useAllLiveSessions } from '@/sync/sync-context';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { DatePicker, TimePill } from '@/components/ui/date-time';
import { useCalendarPreferences } from '@/components/ui/useCalendarPreferences';

// Mirrors the composer's footer icon toggles (PermissionAutoAcceptButton /
// SessionGoalButton) so the state reads the same in both places.
const EDITOR_TOGGLE_BUTTON_CLASS = 'flex h-6 w-6 cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0';

const TIMEZONE_OPTIONS = (() => {
  if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
    return [...new Set(Intl.supportedValuesOf('timeZone').map(canonicalizeTimezone))];
  }
  return [
    'UTC',
    'Europe/Kyiv',
    'Europe/London',
    'Europe/Berlin',
    'America/New_York',
    'America/Los_Angeles',
    'Asia/Tokyo',
  ];
})();

const FieldLabel: React.FC<{
  htmlFor?: string;
  required?: boolean;
  children: React.ReactNode;
}> = ({ htmlFor, required, children }) => (
  <div className="flex items-center gap-1.5">
    <label htmlFor={htmlFor} className="typography-meta font-medium text-foreground">
      {children}
      {required && <span className="ms-0.5 text-destructive">*</span>}
    </label>
  </div>
);

const CronScheduleSection: React.FC<{
  draft: ScheduledTaskDraft;
  setDraft: React.Dispatch<React.SetStateAction<ScheduledTaskDraft>>;
  locale: string;
  t: ReturnType<typeof useI18n>['t'];
}> = ({ draft, setDraft, locale, t }) => {
  const cronExpression = draft.schedule.cronExpression;
  const cronValidation = React.useMemo(
    () => (cronExpression.trim() ? isValidCronExpression(cronExpression) : null),
    [cronExpression],
  );
  const nextRuns = React.useMemo(() => {
    if (!cronValidation?.valid || !cronExpression.trim()) {
      return [];
    }
    return getNextRuns(cronExpression, draft.schedule.timezone);
  }, [cronExpression, cronValidation, draft.schedule.timezone]);

  const formatNextRun = React.useCallback(
    (date: Date) => new Intl.DateTimeFormat(locale, {
      timeZone: draft.schedule.timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date),
    [locale, draft.schedule.timezone],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor="sched-cron" required>{t('sessions.scheduledTasks.editor.cronExpression.label')}</FieldLabel>
        <Input
          id="sched-cron"
          value={cronExpression}
          onChange={(event) => setDraft((prev) => ({
            ...prev,
            schedule: { ...prev.schedule, cronExpression: event.target.value },
          }))}
          placeholder={t('sessions.scheduledTasks.editor.cronExpression.placeholder')}
          className="w-full max-w-xs font-mono"
        />
        {cronValidation && !cronValidation.valid && cronExpression.trim() ? (
          <span className="typography-micro text-destructive">
            {t('sessions.scheduledTasks.editor.validation.cronInvalid')}
          </span>
        ) : null}
      </div>

      {nextRuns.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="typography-meta text-muted-foreground">{t('sessions.scheduledTasks.editor.cronExpression.nextRuns')}</span>
          <span className="typography-micro text-foreground">
            {nextRuns.map(formatNextRun).join(', ')}
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="typography-meta text-muted-foreground">{t('sessions.scheduledTasks.editor.cronExpression.examples')}</span>
        <div className="flex flex-wrap gap-1.5">
          {CRON_EXAMPLES.map((example) => (
            <button
              key={example.expression}
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 typography-micro text-foreground hover:bg-interactive-hover"
              onClick={() => setDraft((prev) => ({
                ...prev,
                schedule: { ...prev.schedule, cronExpression: example.expression },
              }))}
            >
              <span className="font-mono">{example.expression}</span>
              <span className="text-muted-foreground">{t(example.labelKey as Parameters<typeof t>[0])}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <FieldLabel>{t('sessions.scheduledTasks.editor.timezone.label')}</FieldLabel>
        <Select
          value={draft.schedule.timezone}
          onValueChange={(timezone) => {
            setDraft((prev) => ({
              ...prev,
              schedule: { ...prev.schedule, timezone },
            }));
          }}
        >
          <SelectTrigger className="w-fit max-w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TIMEZONE_OPTIONS.map((timezone) => (
              <SelectItem key={timezone} value={timezone}>{timezone}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};

export function ScheduledTaskEditorDialog(props: {
  open: boolean;
  task: ScheduledTask | null;
  projectId: string;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: Partial<ScheduledTask>) => Promise<void>;
}) {
  const { open, task, onOpenChange, onSave } = props;
  const { t, locale } = useI18n();
  const globalSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const liveSessions = useAllLiveSessions();
  // Candidates only. Whether one belongs to the task is the scheduler's own
  // membership rule, fetched below, so this list never re-implements the
  // policy the backend enforces on save and run (#4757).
  const candidates = React.useMemo(() => {
    const merged = new Map(globalSessions.map((session) => [session.id, session]));
    for (const session of liveSessions) merged.set(session.id, session);
    return [...merged.values()].filter((session) => !session.time?.archived);
  }, [globalSessions, liveSessions]);
  // The eligibility request depends on which sessions sit in which directory,
  // never on the session objects, which change on every step an agent takes.
  const candidatesKey = React.useMemo(
    () => candidates.map((session) => `${session.id}:${session.directory ?? ''}`).sort().join('\n'),
    [candidates],
  );
  const candidatesRef = React.useRef(candidates);
  candidatesRef.current = candidates;
  const [eligibility, setEligibility] = React.useState<
    { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; ids: ReadonlySet<string> }
  >({ status: 'idle' });
  const [eligibilityAttempt, setEligibilityAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!open || !props.projectId || !candidatesKey) {
      setEligibility({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    setEligibility((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    fetchEligibleScheduledTaskTargets(
      props.projectId,
      candidatesRef.current.map((session) => ({ sessionId: session.id, directory: session.directory ?? '' })),
      controller.signal,
    ).then(
      (ids) => setEligibility({ status: 'ready', ids }),
      () => {
        // A failed read is an error, never an empty list: the picker would
        // otherwise read as "this project has no sessions".
        if (!controller.signal.aborted) setEligibility({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [open, props.projectId, candidatesKey, eligibilityAttempt]);
  const sessions = React.useMemo(
    () => (eligibility.status === 'ready' ? candidates.filter((session) => eligibility.ids.has(session.id)) : []),
    [candidates, eligibility],
  );
  React.useEffect(() => {
    if (open) void refreshGlobalSessions().catch(() => undefined);
  }, [open]);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderID = useConfigStore((state) => state.currentProviderId);
  const currentModelID = useConfigStore((state) => state.currentModelId);
  const currentVariant = useConfigStore((state) => state.currentVariant || '');
  const currentAgentName = useConfigStore((state) => state.currentAgentName || '');
  const isMobile = useUIStore((state) => state.isMobile);
  // The project the run works in: the base-branch picker reads its branches
  // from here, the same way the New worktree dialog and multi-run do.
  const projectPath = useProjectsStore((state) => state.projects.find((entry) => entry.id === props.projectId)?.path ?? null);
  // Same hook `BranchSelector` uses; calling it here only reads the store's
  // answer so the editor can say when the folder is not a repository.
  const branchOptions = useBranchOptions(projectPath);

  const [draft, setDraft] = React.useState<ScheduledTaskDraft>(() =>
    toDraft(task, {
      providerID: currentProviderID,
      modelID: currentModelID,
      variant: currentVariant,
      agent: currentAgentName,
    })
  );
  const [saving, setSaving] = React.useState(false);
  const [showFileMention, setShowFileMention] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState('');
  const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState('');
  const [showSnippetAutocomplete, setShowSnippetAutocomplete] = React.useState(false);
  const [snippetQuery, setSnippetQuery] = React.useState('');
  const promptTextareaRef = React.useRef<HTMLTextAreaElement>(null);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);
  const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
  const { use24Hour, weekdays: orderedWeekdays } = useCalendarPreferences();

  React.useEffect(() => {
    if (!open) {
      return;
    }
    void loadProviders({ source: 'scheduledTaskEditor' });
    void loadAgents({ source: 'scheduledTaskEditor' });
  }, [open, loadProviders, loadAgents]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(
      toDraft(task, {
        providerID: currentProviderID,
        modelID: currentModelID,
        variant: currentVariant,
        agent: currentAgentName,
      })
    );
    setShowCommandAutocomplete(false);
    setShowFileMention(false);
    setCommandQuery('');
    setMentionQuery('');
  }, [open, task, currentProviderID, currentModelID, currentVariant, currentAgentName]);

  const variantOptions = React.useMemo(() => {
    const provider = providers.find((item) => item.id === draft.execution.providerID);
    const model = provider?.models?.find((item) => item.id === draft.execution.modelID) as { variants?: ModelVariantSource } | undefined;
    return listModelVariantIds(model?.variants);
  }, [providers, draft.execution.providerID, draft.execution.modelID]);
  const hasVariantOptions = variantOptions.length > 0;
  const selectedVariantValue = React.useMemo(() => {
    if (!hasVariantOptions) {
      return '__default';
    }
    if (!draft.execution.variant) {
      return '__default';
    }
    return variantOptions.includes(draft.execution.variant) ? draft.execution.variant : '__default';
  }, [draft.execution.variant, hasVariantOptions, variantOptions]);

  React.useEffect(() => {
    if (hasVariantOptions || !draft.execution.variant) {
      return;
    }
    setDraft((prev) => ({
      ...prev,
      execution: {
        ...prev.execution,
        variant: '',
      },
    }));
  }, [hasVariantOptions, draft.execution.variant]);

  const toggleWeekday = React.useCallback((weekday: number, nextChecked: boolean) => {
    setDraft((prev) => {
      const current = new Set(prev.schedule.weekdays);
      if (nextChecked) {
        current.add(weekday);
      } else {
        current.delete(weekday);
      }
      return {
        ...prev,
        schedule: {
          ...prev.schedule,
          weekdays: Array.from(current).sort((a, b) => a - b),
        },
      };
    });
  }, []);

  const updateTimeAt = React.useCallback((index: number, value: string) => {
    setDraft((prev) => {
      const next = prev.schedule.times.slice();
      next[index] = value;
      return {
        ...prev,
        schedule: {
          ...prev.schedule,
          times: next,
        },
      };
    });
  }, []);

  const removeTimeAt = React.useCallback((index: number) => {
    setDraft((prev) => {
      const next = prev.schedule.times.filter((_, idx) => idx !== index);
      return {
        ...prev,
        schedule: {
          ...prev.schedule,
          times: next.length > 0 ? next : ['09:00'],
        },
      };
    });
  }, []);

  const addTime = React.useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        times: [...prev.schedule.times, '12:00'],
      },
    }));
  }, []);

  const setOneTimeDate = React.useCallback((isoDate: string) => {
    setDraft((prev) => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        onceDate: isoDate,
      },
    }));
  }, []);

  const updateAutocompleteState = React.useCallback((value: string, cursorPosition: number) => {
    if (value.startsWith('/')) {
      const firstSpace = value.indexOf(' ');
      const firstNewline = value.indexOf('\n');
      const commandEnd = Math.min(
        firstSpace === -1 ? value.length : firstSpace,
        firstNewline === -1 ? value.length : firstNewline,
      );

      if (cursorPosition <= commandEnd && firstSpace === -1) {
        setCommandQuery(value.substring(1, commandEnd));
        setShowCommandAutocomplete(true);
        setShowFileMention(false);
        setShowSnippetAutocomplete(false);
        return;
      }
    }

    setShowCommandAutocomplete(false);

    const textBeforeCursor = value.substring(0, cursorPosition);
    const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
    if (lastHashSymbol !== -1) {
      const charBefore = lastHashSymbol > 0 ? textBeforeCursor[lastHashSymbol - 1] : null;
      const textAfterHash = textBeforeCursor.substring(lastHashSymbol + 1);
      const isWordBoundary = !charBefore || /\s/.test(charBefore);
      if (isWordBoundary && !textAfterHash.includes(' ') && !textAfterHash.includes('\n')) {
        setSnippetQuery(textAfterHash);
        setShowSnippetAutocomplete(true);
        setShowFileMention(false);
        return;
      }
    }

    setShowSnippetAutocomplete(false);

    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    if (lastAtSymbol !== -1) {
      const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
      const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
      const isWordBoundary = !charBefore || /\s/.test(charBefore);
      if (isWordBoundary && !textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
        setMentionQuery(textAfterAt);
        setShowFileMention(true);
      } else {
        setShowFileMention(false);
      }
      return;
    }

    setShowFileMention(false);
  }, []);

  const setPromptValue = React.useCallback((value: string) => {
    setDraft((prev) => ({
      ...prev,
      execution: {
        ...prev.execution,
        prompt: value,
      },
    }));
  }, []);

  const handleFileSelect = React.useCallback((file: { name: string; path: string; relativePath?: string }) => {
    const promptValue = draft.execution.prompt;
    const textarea = promptTextareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? promptValue.length;
    const textBeforeCursor = promptValue.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
      ? file.relativePath.trim()
      : (file.path || file.name);

    const startIndex = lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition;
    const nextPrompt = `${promptValue.substring(0, startIndex)}@${mentionPath} ${promptValue.substring(cursorPosition)}`;
    const nextCursor = startIndex + mentionPath.length + 2;

    setPromptValue(nextPrompt);
    setShowFileMention(false);
    setMentionQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [draft.execution.prompt, setPromptValue, updateAutocompleteState]);

  const handleAgentSelect = React.useCallback((agentName: string) => {
    const promptValue = draft.execution.prompt;
    const textarea = promptTextareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? promptValue.length;
    const textBeforeCursor = promptValue.substring(0, cursorPosition);
    const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
    const startIndex = lastAtSymbol !== -1 ? lastAtSymbol : cursorPosition;
    const nextPrompt = `${promptValue.substring(0, startIndex)}@${agentName} ${promptValue.substring(cursorPosition)}`;
    const nextCursor = startIndex + agentName.length + 2;

    setPromptValue(nextPrompt);
    setShowFileMention(false);
    setMentionQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [draft.execution.prompt, setPromptValue, updateAutocompleteState]);

  const handleCommandSelect = React.useCallback((command: CommandInfo) => {
    const nextPrompt = `/${command.name} `;
    setPromptValue(nextPrompt);
    setShowCommandAutocomplete(false);
    setCommandQuery('');
    setShowSnippetAutocomplete(false);

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.focus();
        currentTextarea.selectionStart = currentTextarea.value.length;
        currentTextarea.selectionEnd = currentTextarea.value.length;
      }
      updateAutocompleteState(nextPrompt, nextPrompt.length);
    });
  }, [setPromptValue, updateAutocompleteState]);

  const handleSnippetSelect = React.useCallback((_snippet: unknown, trigger: string) => {
    const promptValue = draft.execution.prompt;
    const textarea = promptTextareaRef.current;
    const cursorPosition = textarea?.selectionStart ?? promptValue.length;
    const textBeforeCursor = promptValue.substring(0, cursorPosition);
    const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
    const startIndex = lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition;
    const nextPrompt = `${promptValue.substring(0, startIndex)}#${trigger} ${promptValue.substring(cursorPosition)}`;
    const nextCursor = startIndex + trigger.length + 2;

    setPromptValue(nextPrompt);
    setShowSnippetAutocomplete(false);
    setSnippetQuery('');

    requestAnimationFrame(() => {
      const currentTextarea = promptTextareaRef.current;
      if (currentTextarea) {
        currentTextarea.selectionStart = nextCursor;
        currentTextarea.selectionEnd = nextCursor;
        currentTextarea.focus();
      }
      updateAutocompleteState(nextPrompt, nextCursor);
    });
  }, [draft.execution.prompt, setPromptValue, updateAutocompleteState]);

  const handlePromptKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommandAutocomplete && commandRef.current) {
      if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        commandRef.current.handleKeyDown(event.key);
        return;
      }
    }

    if (showFileMention && mentionRef.current) {
      if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        mentionRef.current.handleKeyDown(event.key);
      }
    }

    if (showSnippetAutocomplete && snippetRef.current) {
      if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        snippetRef.current.handleKeyDown(event.key);
      }
    }
  }, [showCommandAutocomplete, showFileMention, showSnippetAutocomplete]);

  const handleSubmit = React.useCallback(async () => {
    const validationError = validateDraft(draft, t);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const payload = buildScheduledTaskPayload(draft);
    if (draft.state && draft.sessionMode === 'new') payload.state = draft.state;
    // A non-git project has nothing to branch from: keep the field honest even
    // when the stored task still asks for isolation. The runtime also falls
    // back to an in-directory run, so this only keeps the record truthful.
    if (draft.sessionMode === 'new' && branchOptions.isGitRepository === false) {
      payload.runInWorktree = false;
    }

    setSaving(true);
    try {
      await onSave(payload);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.editor.toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [branchOptions.isGitRepository, draft, onOpenChange, onSave, t]);

  const descriptionId = React.useId();
  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') return false;
    return Boolean(
      document.querySelector(
        '[data-slot="dropdown-menu-content"][data-open], [data-slot="select-content"][data-open]'
      )
    );
  }, []);

  const title = task ? t('sessions.scheduledTasks.editor.title.edit') : t('sessions.scheduledTasks.editor.title.new');
  const description = t('sessions.scheduledTasks.editor.description');

  const formBody = (
    <div className="flex flex-col gap-5">
      <SettingsStackedField label={t('sessions.scheduledTasks.editor.sessionMode')}>
        <Select value={draft.sessionMode} onValueChange={(value: 'new' | 'existing') => setDraft((prev) => ({
          ...prev, sessionMode: value,
        }))}>
          <SelectTrigger><SelectValue>{draft.sessionMode === 'existing' ? t('sessions.scheduledTasks.editor.existingSession') : t('sessions.scheduledTasks.editor.newSession')}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="new">{t('sessions.scheduledTasks.editor.newSession')}</SelectItem>
            <SelectItem value="existing">{t('sessions.scheduledTasks.editor.existingSession')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsStackedField>
      {draft.sessionMode === 'existing' ? (
        <SettingsStackedField label={t('sessions.scheduledTasks.editor.targetSession')} info={t('sessions.scheduledTasks.editor.targetHint')}>
          <Select value={draft.targetSessionId} onValueChange={(targetSessionId) => setDraft((prev) => ({ ...prev, targetSessionId }))}>
            <SelectTrigger><SelectValue placeholder={t('sessions.scheduledTasks.editor.targetSession')}>
              {candidates.find((session) => session.id === draft.targetSessionId)?.title || draft.targetSessionId || undefined}
            </SelectValue></SelectTrigger>
            <SelectContent>
              {eligibility.status === 'loading'
                ? <SelectItem value="__loading" disabled>{t('common.loading')}</SelectItem>
                : sessions.map((session) => <SelectItem key={session.id} value={session.id}>{session.title || session.id}</SelectItem>)}
            </SelectContent>
          </Select>
          {eligibility.status === 'error' ? (
            <div className="flex items-center gap-2 typography-meta text-muted-foreground">
              <span>{t('sessions.scheduledTasks.editor.targetLoadFailed')}</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => setEligibilityAttempt((attempt) => attempt + 1)}>
                {t('sessions.scheduledTasks.editor.targetRetry')}
              </Button>
            </div>
          ) : null}
        </SettingsStackedField>
      ) : null}
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <FieldLabel htmlFor="sched-name" required>{t('sessions.scheduledTasks.editor.taskName.label')}</FieldLabel>
                    <Input
                      id="sched-name"
                      value={draft.name}
                      onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                      placeholder={t('sessions.scheduledTasks.editor.taskName.placeholder')}
                      maxLength={80}
                      className="w-full sm:max-w-[220px]"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <FieldLabel>{t('sessions.scheduledTasks.editor.scheduleType.label')}</FieldLabel>
                    <Select
                      value={draft.schedule.kind}
                      onValueChange={(value: 'daily' | 'weekly' | 'once' | 'cron') => {
                        setDraft((prev) => ({
                          ...prev,
                          schedule: {
                            ...prev.schedule,
                            kind: value,
                            ...(value === 'cron' && !prev.schedule.cronExpression
                              ? { cronExpression: '0 * * * *' }
                              : {}),
                          },
                        }));
                      }}
                    >
                      <SelectTrigger className="w-fit max-w-full">
                        <SelectValue>
                          {(value) => value === 'daily'
                            ? t('sessions.scheduledTasks.editor.scheduleType.daily')
                            : value === 'weekly'
                              ? t('sessions.scheduledTasks.editor.scheduleType.weekly')
                              : value === 'cron'
                                ? t('sessions.scheduledTasks.editor.scheduleType.cron')
                                : t('sessions.scheduledTasks.editor.scheduleType.once')}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">{t('sessions.scheduledTasks.editor.scheduleType.daily')}</SelectItem>
                        <SelectItem value="weekly">{t('sessions.scheduledTasks.editor.scheduleType.weekly')}</SelectItem>
                        <SelectItem value="once">{t('sessions.scheduledTasks.editor.scheduleType.once')}</SelectItem>
                        <SelectItem value="cron">{t('sessions.scheduledTasks.editor.scheduleType.cron')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                </div>

          {draft.schedule.kind === 'cron' ? (
            <CronScheduleSection draft={draft} setDraft={setDraft} locale={locale} t={t} />
          ) : draft.schedule.kind === 'once' ? (
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <FieldLabel>{t('sessions.scheduledTasks.editor.date.label')}</FieldLabel>
                <DatePicker
                  value={draft.schedule.onceDate}
                  onChange={setOneTimeDate}
                  placeholder={t('sessions.scheduledTasks.editor.date.placeholder')}
                  disablePast
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1">
                <FieldLabel>{t('sessions.scheduledTasks.editor.time.label')}</FieldLabel>
                <TimePill
                  value={draft.schedule.onceTime}
                  use24Hour={use24Hour}
                  hourAriaLabel={t('sessions.scheduledTasks.editor.time.hourAria')}
                  minuteAriaLabel={t('sessions.scheduledTasks.editor.time.minuteAria')}
                  periodAriaLabel={t('sessions.scheduledTasks.editor.time.periodAria')}
                  amLabel={t('sessions.scheduledTasks.editor.time.period.am')}
                  pmLabel={t('sessions.scheduledTasks.editor.time.period.pm')}
                  onChange={(next) => setDraft((prev) => ({
                    ...prev,
                    schedule: { ...prev.schedule, onceTime: next },
                  }))}
                />

                <div className="mt-2 flex flex-col gap-1">
                  <FieldLabel>{t('sessions.scheduledTasks.editor.timezone.label')}</FieldLabel>
                  <Select
                    value={draft.schedule.timezone}
                    onValueChange={(timezone) => {
                      setDraft((prev) => ({
                        ...prev,
                        schedule: { ...prev.schedule, timezone },
                      }));
                    }}
                  >
                    <SelectTrigger className="w-fit max-w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIMEZONE_OPTIONS.map((timezone) => (
                        <SelectItem key={timezone} value={timezone}>{timezone}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              {draft.schedule.kind === 'weekly' ? (
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <FieldLabel>{t('sessions.scheduledTasks.editor.weekdays.label')}</FieldLabel>
                  <div className="flex flex-wrap gap-x-3 gap-y-2">
                    {orderedWeekdays.map((weekday) => {
                      const checked = draft.schedule.weekdays.includes(weekday.value);
                      return (
                        <div
                          key={weekday.value}
                          className={[
                            'group inline-flex items-center gap-1.5 px-0.5 py-0.5 typography-meta',
                            checked ? 'text-foreground' : 'text-muted-foreground',
                          ].join(' ')}
                        >
                          <Checkbox checked={checked} onChange={(next) => toggleWeekday(weekday.value, next)} ariaLabel={weekday.label} />
                          <button
                            type="button"
                            onClick={() => toggleWeekday(weekday.value, !checked)}
                            className="group-hover:text-foreground"
                          >
                            {weekday.label}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-2">
                <FieldLabel>{t('sessions.scheduledTasks.editor.times.label')}</FieldLabel>
                <div className="flex flex-col gap-2">
                  {draft.schedule.times.map((time, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <TimePill
                        value={time}
                        use24Hour={use24Hour}
                        hourAriaLabel={t('sessions.scheduledTasks.editor.time.hourAria')}
                        minuteAriaLabel={t('sessions.scheduledTasks.editor.time.minuteAria')}
                        periodAriaLabel={t('sessions.scheduledTasks.editor.time.periodAria')}
                        amLabel={t('sessions.scheduledTasks.editor.time.period.am')}
                        pmLabel={t('sessions.scheduledTasks.editor.time.period.pm')}
                        onChange={(next) => updateTimeAt(index, next)}
                      />
                      {draft.schedule.times.length > 1 ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeTimeAt(index)}
                          aria-label={t('sessions.scheduledTasks.editor.times.removeAria')}
                        >
                          <Icon name="close" className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div>
                  <Button type="button" size="sm" variant="outline" onClick={addTime}>
                    <Icon name="add" className="me-1 h-4 w-4" /> {t('sessions.scheduledTasks.editor.times.add')}
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <FieldLabel>{t('sessions.scheduledTasks.editor.timezone.label')}</FieldLabel>
                <Select
                  value={draft.schedule.timezone}
                  onValueChange={(timezone) => {
                    setDraft((prev) => ({
                      ...prev,
                      schedule: { ...prev.schedule, timezone },
                    }));
                  }}
                >
                  <SelectTrigger className="w-fit max-w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIMEZONE_OPTIONS.map((timezone) => (
                      <SelectItem key={timezone} value={timezone}>{timezone}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {draft.sessionMode === 'new' && projectPath?.trim() ? (
            <div className="flex flex-col gap-1">
              <label className="inline-flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={draft.runInWorktree}
                  onChange={(runInWorktree) => setDraft((prev) => ({ ...prev, runInWorktree }))}
                  ariaLabel={t('sessions.scheduledTasks.editor.worktree.label')}
                />
                <span className="typography-meta">{t('sessions.scheduledTasks.editor.worktree.label')}</span>
              </label>
              <p className="typography-meta text-muted-foreground">{t('sessions.scheduledTasks.editor.worktree.hint')}</p>
              {/* The picker belongs to isolation, so it is absent while the
                  switch is off rather than sitting there greyed out. */}
              {draft.runInWorktree ? (
                <>
                  <div className="flex flex-col gap-1">
                    <FieldLabel>{t('sessions.scheduledTasks.editor.worktree.baseBranch.label')}</FieldLabel>
                    <BranchSelector
                      directory={projectPath}
                      value={draft.baseBranch}
                      onChange={(branch) => setDraft((prev) => ({ ...prev, baseBranch: branch }))}
                      className="w-fit"
                    />
                    {branchOptions.isGitRepository === false ? (
                      <p className="typography-meta text-muted-foreground">{t('sessions.scheduledTasks.editor.worktree.notRepo')}</p>
                    ) : null}
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={draft.cleanupWorktree}
                      onChange={(cleanupWorktree) => setDraft((prev) => ({ ...prev, cleanupWorktree }))}
                      ariaLabel={t('sessions.scheduledTasks.editor.worktree.cleanup.label')}
                    />
                    <span className="typography-meta">{t('sessions.scheduledTasks.editor.worktree.cleanup.label')}</span>
                  </label>
                  <p className="typography-meta text-muted-foreground">
                    {draft.cleanupWorktree
                      ? t('sessions.scheduledTasks.editor.worktree.cleanup.hint')
                      : t('sessions.scheduledTasks.editor.worktree.cleanup.keepHint')}
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          <label className="inline-flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={draft.execution.useDefaults}
              onChange={(useDefaults) => setDraft((prev) => ({
                ...prev,
                execution: { ...prev.execution, useDefaults },
              }))}
              ariaLabel={t('sessions.scheduledTasks.editor.useDefaults.label')}
            />
            <span className="typography-meta">{t('sessions.scheduledTasks.editor.useDefaults.label')}</span>
          </label>

          {draft.execution.useDefaults ? (
            <p className="typography-meta text-muted-foreground">{draft.sessionMode === 'existing' ? t('sessions.scheduledTasks.editor.targetHint') : t('sessions.scheduledTasks.editor.useDefaults.hint')}</p>
          ) : (
          <>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel required>{t('sessions.scheduledTasks.editor.model.label')}</FieldLabel>
              <ModelSelector
                providerId={draft.execution.providerID}
                modelId={draft.execution.modelID}
                onChange={(providerID, modelID) => {
                  setDraft((prev) => ({
                    ...prev,
                    execution: {
                      ...prev.execution,
                      providerID,
                      modelID,
                      variant: '',
                    },
                  }));
                }}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel>{t('sessions.scheduledTasks.editor.thinkingLevel.label')}</FieldLabel>
              <Select
                value={selectedVariantValue}
                disabled={!hasVariantOptions}
                onValueChange={(value) => {
                  setDraft((prev) => ({
                    ...prev,
                    execution: {
                      ...prev.execution,
                      variant: value === '__default' ? '' : value,
                    },
                  }));
                }}
              >
                <SelectTrigger className="w-fit max-w-full">
                  <SelectValue>
                    {(value) => value === '__default'
                      ? t('sessions.scheduledTasks.editor.thinkingLevel.default')
                      : value}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">{t('sessions.scheduledTasks.editor.thinkingLevel.default')}</SelectItem>
                  {variantOptions.map((variant) => (
                    <SelectItem key={variant} value={variant}>{variant}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <FieldLabel>{t('sessions.scheduledTasks.editor.agent.label')}</FieldLabel>
            <AgentSelector
              agentName={draft.execution.agent}
              filter={(agent) => isPrimaryMode(agent.mode)}
              onChange={(agent) => setDraft((prev) => ({
                ...prev,
                execution: {
                  ...prev.execution,
                  agent,
                },
              }))}
            />
          </div>
          </>
          )}

          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor="sched-prompt" required>{t('sessions.scheduledTasks.editor.prompt.label')}</FieldLabel>
            <div className="relative">
              <Textarea
                id="sched-prompt"
                ref={promptTextareaRef}
                value={draft.execution.prompt}
                onChange={(event) => {
                  const nextPrompt = event.target.value;
                  setPromptValue(nextPrompt);
                  const cursorPosition = event.target.selectionStart ?? nextPrompt.length;
                  updateAutocompleteState(nextPrompt, cursorPosition);
                }}
                onKeyDown={handlePromptKeyDown}
                rows={8}
                placeholder={t('sessions.scheduledTasks.editor.prompt.placeholder')}
                className="typography-meta min-h-[120px] max-h-[300px] resize-none overflow-y-auto"
              />

              {showCommandAutocomplete ? (
                <CommandAutocomplete
                  ref={commandRef}
                  searchQuery={commandQuery}
                  onCommandSelect={handleCommandSelect}
                  onClose={() => setShowCommandAutocomplete(false)}
                  style={{
                    left: 0,
                    top: 'auto',
                    bottom: 'calc(100% + 6px)',
                    marginBottom: 0,
                    maxWidth: '100%',
                  }}
                />
              ) : null}

              {showFileMention ? (
                <FileMentionAutocomplete
                  ref={mentionRef}
                  searchQuery={mentionQuery}
                  onFileSelect={handleFileSelect}
                  onAgentSelect={handleAgentSelect}
                  onClose={() => setShowFileMention(false)}
                  style={{
                    left: 0,
                    top: 'auto',
                    bottom: 'calc(100% + 6px)',
                    marginBottom: 0,
                    maxWidth: '100%',
                  }}
                />
              ) : null}

              {showSnippetAutocomplete ? (
                <SnippetAutocomplete
                  ref={snippetRef}
                  searchQuery={snippetQuery}
                  onSnippetSelect={handleSnippetSelect}
                  onClose={() => setShowSnippetAutocomplete(false)}
                  style={{
                    left: 0,
                    top: 'auto',
                    bottom: 'calc(100% + 6px)',
                    marginBottom: 0,
                    maxWidth: '100%',
                  }}
                />
              ) : null}
            </div>
          </div>

          {draft.sessionMode === 'new' && draft.execution.goalEnabled ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
              <label className="inline-flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={draft.execution.goalTokenBudget !== null}
                  onChange={(hasBudget) => setDraft((prev) => ({
                    ...prev,
                    execution: { ...prev.execution, goalTokenBudget: hasBudget ? 200_000 : null },
                  }))}
                  ariaLabel={t('sessions.scheduledTasks.editor.goal.budgetAria')}
                />
                <span className="typography-meta">{t('sessions.scheduledTasks.editor.goal.budgetLabel')}</span>
              </label>
            {draft.execution.goalTokenBudget !== null ? (
              <NumberInput
                value={draft.execution.goalTokenBudget}
                onValueChange={(value) => {
                  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                    setDraft((prev) => ({
                      ...prev,
                      execution: { ...prev.execution, goalTokenBudget: Math.floor(value) },
                    }));
                  }
                }}
                min={1000}
                max={100000000}
                step={50000}
              />
            ) : null}
          </div>
          ) : null}
    </div>
  );

  const footerRow = (
    <div className="flex items-center justify-between gap-3">
      <label className="inline-flex items-center gap-2">
        <Checkbox
          checked={draft.enabled}
          onChange={(enabled) => setDraft((prev) => ({ ...prev, enabled }))}
          ariaLabel={t('sessions.scheduledTasks.editor.enabled.aria')}
        />
        <span className="typography-meta">{t('sessions.scheduledTasks.editor.enabled.label')}</span>
      </label>

      <div className="flex items-center gap-2">
        {draft.sessionMode === 'new' ? <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(EDITOR_TOGGLE_BUTTON_CLASS)}
              onClick={() => setDraft((prev) => ({
                ...prev,
                execution: { ...prev.execution, permissionAutoAccept: !prev.execution.permissionAutoAccept },
              }))}
              aria-pressed={draft.execution.permissionAutoAccept}
              aria-label={t('sessions.scheduledTasks.editor.permissionAutoAccept.aria')}
            >
              {draft.execution.permissionAutoAccept ? (
                <Icon name="shield-check" className="h-[18px] w-[18px]" style={{ color: 'var(--status-info)' }} aria-hidden="true" />
              ) : (
                <Icon name="shield-user" className="h-[18px] w-[18px]" aria-hidden="true" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('sessions.scheduledTasks.editor.permissionAutoAccept.label')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(EDITOR_TOGGLE_BUTTON_CLASS, draft.execution.goalEnabled && 'text-[var(--status-info)]')}
              onClick={() => setDraft((prev) => ({
                ...prev,
                execution: { ...prev.execution, goalEnabled: !prev.execution.goalEnabled },
              }))}
              aria-pressed={draft.execution.goalEnabled}
              aria-label={t('sessions.scheduledTasks.editor.goal.aria')}
            >
              {draft.execution.goalEnabled ? (
                <Icon name="target-fill" className="h-[18px] w-[18px] text-current" aria-hidden="true" />
              ) : (
                <Icon name="target" className="h-[18px] w-[18px] text-current" aria-hidden="true" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('sessions.scheduledTasks.editor.goal.label')}</TooltipContent>
        </Tooltip>
        </> : null}
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
          {t('sessions.scheduledTasks.editor.actions.cancel')}
        </Button>
        <Button type="button" size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? t('sessions.scheduledTasks.editor.actions.saving') : t('sessions.scheduledTasks.editor.actions.save')}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        title={title}
        onClose={() => onOpenChange(false)}
        contentMaxHeightClassName="max-h-[min(80vh,640px)]"
        renderHeader={(closeButton) => (
          <div className="flex flex-col gap-1 border-b border-edge-muted px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
              {closeButton}
            </div>
            <p className="typography-micro text-muted-foreground">{description}</p>
          </div>
        )}
        footer={footerRow}
      >
        {formBody}
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && hasOpenFloatingMenu()) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-describedby={descriptionId}
        className="!max-w-[720px] w-[90vw] h-[680px] max-h-[85vh] gap-0 p-0 overflow-hidden"
      >
        <DialogDescription id={descriptionId} className="sr-only">
          {description}
        </DialogDescription>

        <header className="shrink-0 px-4 sm:px-6 pt-5 pb-3">
          <div className="mx-auto w-full max-w-2xl">
            <DialogTitle className="typography-ui-label font-medium text-foreground">
              {title}
            </DialogTitle>
            <p className="typography-meta mt-0.5 text-muted-foreground">{description}</p>
          </div>
        </header>

        <ScrollShadow
          className="flex-1 min-h-0 overflow-auto [scrollbar-gutter:stable_both-edges]"
          size={64}
          hideTopShadow
        >
          <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 pb-5">{formBody}</div>
        </ScrollShadow>

        <div className="shrink-0 px-4 sm:px-6 py-3">
          <div className="mx-auto w-full max-w-2xl">{footerRow}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
