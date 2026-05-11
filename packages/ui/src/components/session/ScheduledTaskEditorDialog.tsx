import * as React from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { RiAddLine, RiCloseLine, RiCalendarLine, RiArrowLeftSLine, RiArrowRightSLine, RiArrowDownSLine } from '@remixicon/react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '@/components/chat/CommandAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '@/components/chat/FileMentionAutocomplete';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';
import { useI18n } from '@/lib/i18n';

const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

const TIMEZONE_OPTIONS = (() => {
  if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
    return Intl.supportedValuesOf('timeZone');
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

const getLocalDateISO = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseISODateToLocal = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
};

const formatLocalDateISO = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDateLabel = (isoDate: string, fallbackLabel: string, locale: string): string => {
  const date = parseISODateToLocal(isoDate);
  if (!date) {
    return fallbackLabel;
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
};

const shiftMonth = (date: Date, delta: number): Date => {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
};

const getCalendarCells = (monthDate: Date, weekStartsOn: number): Array<{ date: Date; inCurrentMonth: boolean }> => {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const firstWeekday = firstDay.getDay();
  const leadDays = (firstWeekday - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells: Array<{ date: Date; inCurrentMonth: boolean }> = [];
  for (let index = 0; index < 42; index += 1) {
    const dayOffset = index - leadDays + 1;
    if (dayOffset <= 0) {
      const day = daysInPrevMonth + dayOffset;
      cells.push({ date: new Date(year, month - 1, day), inCurrentMonth: false });
      continue;
    }
    if (dayOffset > daysInMonth) {
      cells.push({ date: new Date(year, month + 1, dayOffset - daysInMonth), inCurrentMonth: false });
      continue;
    }
    cells.push({ date: new Date(year, month, dayOffset), inCurrentMonth: true });
  }
  return cells;
};

const parse24hTime = (value: string): { hour24: string; hour12: string; minute: string; meridiem: 'AM' | 'PM' } => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return { hour24: '00', hour12: '12', minute: '00', meridiem: 'AM' };
  }
  const hour24 = Number(match[1]);
  const minute = match[2];
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const rawHour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return {
    hour24: String(hour24).padStart(2, '0'),
    hour12: String(rawHour12).padStart(2, '0'),
    minute,
    meridiem,
  };
};

const to24hTime = (hour12: string, minute: string, meridiem: 'AM' | 'PM'): string => {
  const hourNumRaw = Number(hour12);
  const minuteNumRaw = Number(minute);
  const hourNum = Number.isFinite(hourNumRaw) ? Math.min(12, Math.max(1, hourNumRaw)) : 12;
  const minuteNum = Number.isFinite(minuteNumRaw) ? Math.min(59, Math.max(0, minuteNumRaw)) : 0;

  let hour24 = hourNum % 12;
  if (meridiem === 'PM') {
    hour24 += 12;
  }
  return `${String(hour24).padStart(2, '0')}:${String(minuteNum).padStart(2, '0')}`;
};

const getValidNumber = (value: string, config: { max: number; min?: number; loop?: boolean }) => {
  const { max, min = 0, loop = false } = config;
  let numericValue = Number.parseInt(value, 10);

  if (Number.isFinite(numericValue)) {
    if (!loop) {
      if (numericValue > max) {
        numericValue = max;
      }
      if (numericValue < min) {
        numericValue = min;
      }
    } else {
      if (numericValue > max) {
        numericValue = min;
      }
      if (numericValue < min) {
        numericValue = max;
      }
    }
    return String(numericValue).padStart(2, '0');
  }

  return '00';
};

const getValid12Hour = (value: string) => {
  if (/^(0[1-9]|1[0-2])$/.test(value)) {
    return value;
  }
  return getValidNumber(value, { min: 1, max: 12 });
};

const getValidMinute = (value: string) => {
  if (/^[0-5][0-9]$/.test(value)) {
    return value;
  }
  return getValidNumber(value, { max: 59 });
};

const getArrowHour = (value: string, step: number) => {
  return getValidNumber(String(Number.parseInt(value, 10) + step), { min: 1, max: 12, loop: true });
};

const getArrowMinute = (value: string, step: number) => {
  return getValidNumber(String(Number.parseInt(value, 10) + step), { min: 0, max: 59, loop: true });
};

const getWeekStartsOn = (locale: string): number => {
  try {
    const localeApi = (Intl as unknown as {
      Locale?: new (tag: string) => { weekInfo?: { firstDay?: number } };
    }).Locale;
    if (typeof localeApi !== 'function') {
      return 1;
    }
    const weekInfo = new localeApi(locale).weekInfo;
    const firstDayRaw = weekInfo?.firstDay;
    if (typeof firstDayRaw !== 'number') {
      return 1;
    }
    return firstDayRaw % 7;
  } catch {
    return 1;
  }
};

const getUses24Hour = (locale: string): boolean => {
  try {
    const options = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
    if (typeof options.hour12 === 'boolean') {
      return !options.hour12;
    }
    return options.hourCycle === 'h23' || options.hourCycle === 'h24';
  } catch {
    return true;
  }
};

const getLocalizedWeekdayLabels = (locale: string): string[] => {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const sundayBase = new Date(2023, 0, 1);
  return WEEKDAY_INDEXES.map((offset) => formatter.format(new Date(sundayBase.getFullYear(), sundayBase.getMonth(), sundayBase.getDate() + offset)));
};

const rotateWeekdays = <T,>(items: T[], weekStartsOn: number): T[] => {
  return [...items.slice(weekStartsOn), ...items.slice(0, weekStartsOn)];
};

interface TimePillProps {
  value: string;
  onChange: (next: string) => void;
  use24Hour: boolean;
  hourAriaLabel: string;
  minuteAriaLabel: string;
  periodAriaLabel: string;
  amLabel: string;
  pmLabel: string;
}

const FieldLabel: React.FC<{
  htmlFor?: string;
  required?: boolean;
  children: React.ReactNode;
}> = ({ htmlFor, required, children }) => (
  <div className="flex items-center gap-1.5">
    <label htmlFor={htmlFor} className="typography-meta font-medium text-foreground">
      {children}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  </div>
);

const TimePill: React.FC<TimePillProps> = ({
  value,
  onChange,
  use24Hour,
  hourAriaLabel,
  minuteAriaLabel,
  periodAriaLabel,
  amLabel,
  pmLabel,
}) => {
  const parts = React.useMemo(() => parse24hTime(value), [value]);
  const hourRef = React.useRef<HTMLInputElement>(null);
  const minuteRef = React.useRef<HTMLInputElement>(null);
  const [hourDraft, setHourDraftState] = React.useState<string | null>(null);
  const [minuteDraft, setMinuteDraftState] = React.useState<string | null>(null);
  const hourDraftRef = React.useRef<string | null>(null);
  const minuteDraftRef = React.useRef<string | null>(null);

  const setHourDraft = React.useCallback((next: string | null) => {
    hourDraftRef.current = next;
    setHourDraftState(next);
  }, []);
  const setMinuteDraft = React.useCallback((next: string | null) => {
    minuteDraftRef.current = next;
    setMinuteDraftState(next);
  }, []);

  const getValid24Hour = (hour: string) => getValidNumber(hour, { min: 0, max: 23 });
  const getArrow24Hour = (hour: string, step: number) => getValidNumber(String(Number.parseInt(hour, 10) + step), {
    min: 0,
    max: 23,
    loop: true,
  });
  const to24hFrom24Hour = (hour24: string, minute: string) => {
    const hourNumRaw = Number(hour24);
    const minuteNumRaw = Number(minute);
    const hourNum = Number.isFinite(hourNumRaw) ? Math.min(23, Math.max(0, hourNumRaw)) : 0;
    const minuteNum = Number.isFinite(minuteNumRaw) ? Math.min(59, Math.max(0, minuteNumRaw)) : 0;
    return `${String(hourNum).padStart(2, '0')}:${String(minuteNum).padStart(2, '0')}`;
  };

  const onHourChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    setHourDraft(digits);
    if (digits.length === 2) {
      if (use24Hour) {
        onChange(to24hFrom24Hour(getValid24Hour(digits), parts.minute));
      } else {
        onChange(to24hTime(getValid12Hour(digits), parts.minute, parts.meridiem));
      }
      setHourDraft(null);
      minuteRef.current?.focus();
    }
  };
  const commitHour = () => {
    const digits = hourDraftRef.current;
    if (digits === null) return;
    setHourDraft(null);
    if (digits.length === 0) return;
    if (use24Hour) {
      onChange(to24hFrom24Hour(getValid24Hour(digits.padStart(2, '0')), parts.minute));
      return;
    }
    onChange(to24hTime(getValid12Hour(digits.padStart(2, '0')), parts.minute, parts.meridiem));
  };
  const onMinuteChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    setMinuteDraft(digits);
    if (digits.length === 2) {
      onChange(use24Hour
        ? to24hFrom24Hour(parts.hour24, getValidMinute(digits))
        : to24hTime(parts.hour12, getValidMinute(digits), parts.meridiem));
      setMinuteDraft(null);
    }
  };
  const commitMinute = () => {
    const digits = minuteDraftRef.current;
    if (digits === null) return;
    setMinuteDraft(null);
    if (digits.length === 0) return;
    onChange(use24Hour
      ? to24hFrom24Hour(parts.hour24, getValidMinute(digits.padStart(2, '0')))
      : to24hTime(parts.hour12, getValidMinute(digits.padStart(2, '0')), parts.meridiem));
  };
  const stepHour = (step: number) =>
    onChange(use24Hour
      ? to24hFrom24Hour(getArrow24Hour(parts.hour24, step), parts.minute)
      : to24hTime(getArrowHour(parts.hour12, step), parts.minute, parts.meridiem));
  const stepMinute = (step: number) =>
    onChange(use24Hour
      ? to24hFrom24Hour(parts.hour24, getArrowMinute(parts.minute, step))
      : to24hTime(parts.hour12, getArrowMinute(parts.minute, step), parts.meridiem));
  const setPeriod = (next: 'AM' | 'PM') => {
    if (next !== parts.meridiem) {
      onChange(to24hTime(parts.hour12, parts.minute, next));
    }
  };

  const onHourKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      commitHour();
      minuteRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setHourDraft(null);
      stepHour(event.key === 'ArrowUp' ? 1 : -1);
    }
  };
  const onMinuteKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowLeft' && (event.currentTarget.selectionStart ?? 0) === 0) {
      event.preventDefault();
      commitMinute();
      hourRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setMinuteDraft(null);
      stepMinute(event.key === 'ArrowUp' ? 1 : -1);
    }
  };

  return (
    <div
      className={cn(
        'inline-flex h-9 w-fit items-center gap-1 rounded-md border border-border bg-background focus-within:ring-1 focus-within:ring-interactive-focusRing focus-within:border-interactive-focusRing',
        use24Hour ? 'px-2' : 'pl-2 pr-1',
      )}
    >
      <input
        ref={hourRef}
        inputMode="numeric"
        value={hourDraft ?? (use24Hour ? parts.hour24 : parts.hour12)}
        onChange={(event) => onHourChange(event.target.value)}
        onKeyDown={onHourKeyDown}
        onFocus={() => setHourDraft('')}
        onBlur={commitHour}
        maxLength={2}
        aria-label={hourAriaLabel}
        className="h-7 w-7 shrink-0 rounded-sm bg-transparent text-center font-mono text-sm tabular-nums text-foreground outline-none caret-transparent focus:bg-interactive-hover"
      />
      <span className="font-mono text-sm text-muted-foreground">:</span>
      <input
        ref={minuteRef}
        inputMode="numeric"
        value={minuteDraft ?? parts.minute}
        onChange={(event) => onMinuteChange(event.target.value)}
        onKeyDown={onMinuteKeyDown}
        onFocus={() => setMinuteDraft('')}
        onBlur={commitMinute}
        maxLength={2}
        aria-label={minuteAriaLabel}
        className="h-7 w-7 shrink-0 rounded-sm bg-transparent text-center font-mono text-sm tabular-nums text-foreground outline-none caret-transparent focus:bg-interactive-hover"
      />
      {!use24Hour ? (
        <Select value={parts.meridiem} onValueChange={(next) => setPeriod(next as 'AM' | 'PM')}>
          <SelectTrigger
            aria-label={periodAriaLabel}
            className="ml-1 h-7 w-fit border-0 bg-transparent pl-2 pr-1 shadow-none hover:bg-interactive-hover focus:ring-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="AM">{amLabel}</SelectItem>
            <SelectItem value="PM">{pmLabel}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
};

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);

const startOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

const isSameCalendarDay = (a: Date, b: Date) => (
  a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth()
  && a.getDate() === b.getDate()
);

type ScheduledTaskDraft = {
  id?: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: 'daily' | 'weekly' | 'once';
    times: string[];
    onceDate: string;
    onceTime: string;
    weekdays: number[];
    timezone: string;
  };
  execution: {
    prompt: string;
    providerID: string;
    modelID: string;
    variant: string;
    agent: string;
  };
  state?: ScheduledTask['state'];
};

const normalizeDraftTimes = (task: ScheduledTask | null): string[] => {
  if (!task) {
    return ['09:00'];
  }
  const candidates = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : (task.schedule.time ? [task.schedule.time] : []);

  const valid = candidates
    .filter((value) => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value))
    .map((value) => value.trim());

  const unique = Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
  return unique.length > 0 ? unique : ['09:00'];
};

const toDraft = (
  task: ScheduledTask | null,
  defaults: {
    providerID: string;
    modelID: string;
    variant: string;
    agent: string;
  },
): ScheduledTaskDraft => {
  const timezoneFallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!task) {
    return {
      name: '',
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:00'],
        onceDate: getLocalDateISO(),
        onceTime: '09:00',
        weekdays: [1],
        timezone: timezoneFallback,
      },
      execution: {
        prompt: '',
        providerID: defaults.providerID,
        modelID: defaults.modelID,
        variant: defaults.variant,
        agent: defaults.agent,
      },
    };
  }

  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    schedule: {
      kind: task.schedule.kind === 'once'
        ? 'once'
        : (task.schedule.kind === 'weekly' ? 'weekly' : 'daily'),
      times: normalizeDraftTimes(task),
      onceDate: typeof task.schedule.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.schedule.date)
        ? task.schedule.date
        : getLocalDateISO(),
      onceTime: typeof task.schedule.time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(task.schedule.time)
        ? task.schedule.time
        : '09:00',
      weekdays: Array.isArray(task.schedule.weekdays) ? task.schedule.weekdays : [1],
      timezone: task.schedule.timezone || timezoneFallback,
    },
    execution: {
      prompt: task.execution.prompt,
      providerID: task.execution.providerID,
      modelID: task.execution.modelID,
      variant: task.execution.variant || '',
      agent: task.execution.agent || '',
    },
    state: task.state,
  };
};

const validateDraft = (draft: ScheduledTaskDraft, t: ReturnType<typeof useI18n>['t']): string | null => {
  if (!draft.name.trim()) {
    return t('sessions.scheduledTasks.editor.validation.taskNameRequired');
  }
  if (!draft.execution.prompt.trim()) {
    return t('sessions.scheduledTasks.editor.validation.promptRequired');
  }
  if (!draft.execution.providerID.trim() || !draft.execution.modelID.trim()) {
    return t('sessions.scheduledTasks.editor.validation.modelRequired');
  }

  if (draft.schedule.kind === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.schedule.onceDate)) {
      return t('sessions.scheduledTasks.editor.validation.dateFormat');
    }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(draft.schedule.onceTime)) {
      return t('sessions.scheduledTasks.editor.validation.timeFormat');
    }
  } else {
    const validTimes = draft.schedule.times.filter((value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
    if (validTimes.length === 0) {
      return t('sessions.scheduledTasks.editor.validation.atLeastOneTime');
    }
  }

  if (draft.schedule.kind === 'weekly' && draft.schedule.weekdays.length === 0) {
    return t('sessions.scheduledTasks.editor.validation.atLeastOneWeekday');
  }

  if (!draft.schedule.timezone.trim()) {
    return t('sessions.scheduledTasks.editor.validation.timezoneRequired');
  }

  return null;
};

const dedupeSortTimes = (times: string[]) => {
  const filtered = times.filter((value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
  return Array.from(new Set(filtered)).sort((a, b) => a.localeCompare(b));
};

export function ScheduledTaskEditorDialog(props: {
  open: boolean;
  task: ScheduledTask | null;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: Partial<ScheduledTask>) => Promise<void>;
}) {
  const { open, task, onOpenChange, onSave } = props;
  const { t, locale } = useI18n();
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderID = useConfigStore((state) => state.currentProviderId);
  const currentModelID = useConfigStore((state) => state.currentModelId);
  const currentVariant = useConfigStore((state) => state.currentVariant || '');
  const currentAgentName = useConfigStore((state) => state.currentAgentName || '');
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const weekStartPreference = useUIStore((state) => state.weekStartPreference);
  const isMobile = useUIStore((state) => state.isMobile);

  const [draft, setDraft] = React.useState<ScheduledTaskDraft>(() =>
    toDraft(task, {
      providerID: currentProviderID,
      modelID: currentModelID,
      variant: currentVariant,
      agent: currentAgentName,
    })
  );
  const [saving, setSaving] = React.useState(false);
  const [isDatePickerOpen, setIsDatePickerOpen] = React.useState(false);
  const [showFileMention, setShowFileMention] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState('');
  const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState('');
  const [calendarMonth, setCalendarMonth] = React.useState<Date>(() => {
    const initialDate = parseISODateToLocal(task?.schedule?.date || '') || new Date();
    return new Date(initialDate.getFullYear(), initialDate.getMonth(), 1);
  });
  const datePickerRef = React.useRef<HTMLDivElement>(null);
  const promptTextareaRef = React.useRef<HTMLTextAreaElement>(null);
  const mentionRef = React.useRef<FileMentionHandle>(null);
  const commandRef = React.useRef<CommandAutocompleteHandle>(null);
  const localeUse24Hour = React.useMemo(() => getUses24Hour(locale), [locale]);
  const localeWeekStartsOn = React.useMemo(() => getWeekStartsOn(locale), [locale]);
  const use24Hour = React.useMemo(() => {
    if (timeFormatPreference === '24h') {
      return true;
    }
    if (timeFormatPreference === '12h') {
      return false;
    }
    return localeUse24Hour;
  }, [timeFormatPreference, localeUse24Hour]);
  const weekStartsOn = React.useMemo(() => {
    if (weekStartPreference === 'sunday') {
      return 0;
    }
    if (weekStartPreference === 'monday') {
      return 1;
    }
    return localeWeekStartsOn;
  }, [weekStartPreference, localeWeekStartsOn]);
  const orderedWeekdays = React.useMemo(() => {
    const labels = getLocalizedWeekdayLabels(locale);
    return rotateWeekdays(
      WEEKDAY_INDEXES.map((value) => ({ value, label: labels[value] || '' })),
      weekStartsOn,
    );
  }, [locale, weekStartsOn]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    void loadProviders();
    void loadAgents();
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
    const sourceDate = parseISODateToLocal(task?.schedule?.date || '') || new Date();
    setCalendarMonth(new Date(sourceDate.getFullYear(), sourceDate.getMonth(), 1));
    setIsDatePickerOpen(false);
    setShowCommandAutocomplete(false);
    setShowFileMention(false);
    setCommandQuery('');
    setMentionQuery('');
  }, [open, task, currentProviderID, currentModelID, currentVariant, currentAgentName]);

  React.useEffect(() => {
    if (!isDatePickerOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (datePickerRef.current && !datePickerRef.current.contains(event.target as Node)) {
        setIsDatePickerOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [isDatePickerOpen]);


  const variantOptions = React.useMemo(() => {
    const provider = providers.find((item) => item.id === draft.execution.providerID);
    const model = provider?.models?.find((item) => item.id === draft.execution.modelID) as { variants?: Record<string, unknown> } | undefined;
    return model?.variants ? Object.keys(model.variants) : [];
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

  const todayDate = React.useMemo(() => startOfToday(), []);
  const currentMonthStart = React.useMemo(() => startOfMonth(todayDate), [todayDate]);
  const selectedDateLabel = React.useMemo(() => {
    const selectedDate = parseISODateToLocal(draft.schedule.onceDate);
    if (!selectedDate) {
      return null;
    }
    if (isSameCalendarDay(selectedDate, todayDate)) {
      return t('sessions.scheduledTasks.editor.date.today');
    }
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(selectedDate);
  }, [draft.schedule.onceDate, locale, t, todayDate]);
  const isAtCurrentMonth = React.useMemo(
    () => startOfMonth(calendarMonth).getTime() <= currentMonthStart.getTime(),
    [calendarMonth, currentMonthStart],
  );
  const calendarWeekdayLabels = React.useMemo(
    () => orderedWeekdays.map((weekday) => weekday.label),
    [orderedWeekdays],
  );

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
        return;
      }
    }

    setShowCommandAutocomplete(false);

    const textBeforeCursor = value.substring(0, cursorPosition);
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
  }, [showCommandAutocomplete, showFileMention]);

  const handleSubmit = React.useCallback(async () => {
    const validationError = validateDraft(draft, t);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const normalizedTimes = dedupeSortTimes(draft.schedule.times);
    const payload: Partial<ScheduledTask> = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      enabled: draft.enabled,
      schedule: {
        kind: draft.schedule.kind,
        timezone: draft.schedule.timezone.trim(),
        ...(draft.schedule.kind === 'once'
          ? {
              date: draft.schedule.onceDate,
              time: draft.schedule.onceTime,
            }
          : {
              times: normalizedTimes,
              ...(draft.schedule.kind === 'weekly' ? { weekdays: draft.schedule.weekdays } : {}),
            }),
      },
      execution: {
        prompt: draft.execution.prompt,
        providerID: draft.execution.providerID,
        modelID: draft.execution.modelID,
        ...(draft.execution.variant.trim() ? { variant: draft.execution.variant.trim() } : {}),
        ...(draft.execution.agent.trim() ? { agent: draft.execution.agent.trim() } : {}),
      },
      ...(draft.state ? { state: draft.state } : {}),
    };

    setSaving(true);
    try {
      await onSave(payload);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.editor.toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [draft, onOpenChange, onSave, t]);

  const descriptionId = React.useId();
  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') return false;
    return Boolean(
      document.querySelector(
        '[data-slot="dropdown-menu-content"], [data-slot="select-content"]'
      )
    );
  }, []);

  const title = task ? t('sessions.scheduledTasks.editor.title.edit') : t('sessions.scheduledTasks.editor.title.new');
  const description = t('sessions.scheduledTasks.editor.description');

  const formBody = (
    <div className="flex flex-col gap-5">
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
                      onValueChange={(value: 'daily' | 'weekly' | 'once') => {
                        setDraft((prev) => ({
                          ...prev,
                          schedule: { ...prev.schedule, kind: value },
                        }));
                      }}
                    >
                      <SelectTrigger className="w-fit max-w-full">
                        <SelectValue>
                          {(value) => value === 'daily'
                            ? t('sessions.scheduledTasks.editor.scheduleType.daily')
                            : value === 'weekly'
                              ? t('sessions.scheduledTasks.editor.scheduleType.weekly')
                              : t('sessions.scheduledTasks.editor.scheduleType.once')}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="daily">{t('sessions.scheduledTasks.editor.scheduleType.daily')}</SelectItem>
                        <SelectItem value="weekly">{t('sessions.scheduledTasks.editor.scheduleType.weekly')}</SelectItem>
                        <SelectItem value="once">{t('sessions.scheduledTasks.editor.scheduleType.once')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                </div>

          {draft.schedule.kind === 'once' ? (
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1" ref={datePickerRef}>
                <FieldLabel>{t('sessions.scheduledTasks.editor.date.label')}</FieldLabel>
                <div className="relative">
                  <button
                    type="button"
                    className="inline-flex h-9 w-fit max-w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-left hover:bg-interactive-hover"
                    onClick={() => setIsDatePickerOpen((prev) => !prev)}
                  >
                    <span className="inline-flex items-center gap-2">
                      <RiCalendarLine className="h-4 w-4 text-muted-foreground" />
                      <span className="typography-ui-label text-foreground">{formatDateLabel(draft.schedule.onceDate, t('sessions.scheduledTasks.editor.date.placeholder'), locale)}</span>
                    </span>
                    <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
                  </button>

                  {isDatePickerOpen ? (
                    <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-[288px] rounded-xl border border-border bg-background p-3 shadow-sm">
                      <div className="mb-2 flex items-center justify-between">
                        <button
                          type="button"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => setCalendarMonth((prev) => shiftMonth(prev, -1))}
                          aria-label={t('sessions.scheduledTasks.editor.date.previousMonth')}
                          disabled={isAtCurrentMonth}
                        >
                          <RiArrowLeftSLine className="h-4 w-4" />
                        </button>
                        <div className="typography-ui-label text-foreground">
                          {new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(calendarMonth)}
                        </div>
                        <button
                          type="button"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-interactive-hover"
                          onClick={() => setCalendarMonth((prev) => shiftMonth(prev, 1))}
                          aria-label={t('sessions.scheduledTasks.editor.date.nextMonth')}
                        >
                          <RiArrowRightSLine className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="mb-1 grid grid-cols-7 gap-1 px-1">
                        {calendarWeekdayLabels.map((weekday, index) => (
                          <div key={`${weekday}-${index}`} className="py-1 text-center typography-micro text-muted-foreground">
                            {weekday}
                          </div>
                        ))}
                      </div>

                      <div className="grid grid-cols-7 gap-1">
                        {getCalendarCells(calendarMonth, weekStartsOn).map(({ date, inCurrentMonth }) => {
                          const isoDate = formatLocalDateISO(date);
                          const isSelected = isoDate === draft.schedule.onceDate;
                          const isToday = isSameCalendarDay(date, todayDate);
                          const isPast = date.getTime() < todayDate.getTime();
                          const dayClass = isSelected
                            ? 'bg-interactive-selection text-interactive-selection-foreground'
                            : (isPast
                              ? 'text-muted-foreground/40'
                              : (inCurrentMonth
                                ? 'text-foreground hover:bg-interactive-hover'
                                : 'text-muted-foreground/60 hover:bg-interactive-hover'));
                          return (
                            <button
                              key={isoDate}
                              type="button"
                              onClick={() => {
                                if (isPast) {
                                  return;
                                }
                                setOneTimeDate(isoDate);
                                setIsDatePickerOpen(false);
                              }}
                              disabled={isPast}
                              className={[
                                'h-8 rounded-md typography-ui-label',
                                dayClass,
                                isToday && !isSelected
                                  ? 'ring-1 ring-inset ring-interactive-focusRing bg-interactive-hover/50'
                                  : '',
                                isPast ? 'cursor-not-allowed opacity-45' : '',
                              ].join(' ')}
                            >
                              {date.getDate()}
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                        <div className="typography-micro text-muted-foreground">{selectedDateLabel || ''}</div>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setOneTimeDate(formatLocalDateISO(todayDate));
                            setCalendarMonth(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1));
                          }}
                        >
                          {t('sessions.scheduledTasks.editor.date.jumpToToday')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
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
                          <RiCloseLine className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div>
                  <Button type="button" size="sm" variant="outline" onClick={addTime}>
                    <RiAddLine className="mr-1 h-4 w-4" /> {t('sessions.scheduledTasks.editor.times.add')}
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
            </div>
          </div>
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
          <div className="flex flex-col gap-1 border-b border-border/40 px-3 py-2">
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
