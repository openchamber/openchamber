import * as React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useCalendarPreferences } from '@/components/ui/useCalendarPreferences';

/**
 * Dates and times as the app asks for them: local ISO dates, a month
 * calendar, and a time field that follows the 12/24-hour preference. Shared
 * by the scheduled task editor and the date field of UI blocks.
 */

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

export const TimePill: React.FC<TimePillProps> = ({
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
        // The height of a dropdown trigger, so a date and its time line up in one row.
        'oc-surface-elevated oc-raised oc-field inline-flex h-7 w-fit items-center gap-1 rounded-md bg-surface-elevated',
        use24Hour ? 'px-2' : 'ps-2 pe-1',
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
        className="h-6 w-7 shrink-0 rounded-sm bg-transparent text-center font-mono text-sm tabular-nums text-foreground outline-none caret-transparent focus:bg-interactive-hover"
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
        className="h-6 w-7 shrink-0 rounded-sm bg-transparent text-center font-mono text-sm tabular-nums text-foreground outline-none caret-transparent focus:bg-interactive-hover"
      />
      {!use24Hour ? (
        <Select value={parts.meridiem} onValueChange={(next) => setPeriod(next as 'AM' | 'PM')}>
          <SelectTrigger
            aria-label={periodAriaLabel}
            className="ms-1 h-6 min-h-6 w-fit bg-transparent dark:bg-transparent ps-2 pe-1 shadow-none hover:bg-interactive-hover"
          >
            <SelectValue>{parts.meridiem === 'PM' ? pmLabel : amLabel}</SelectValue>
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

/**
 * A date as a dropdown trigger that opens a month calendar. The value is a
 * local ISO date (YYYY-MM-DD), empty for none. With `disablePast`, days and
 * months before today cannot be picked.
 */
export function DatePicker({ value, onChange, placeholder, disablePast = false, disabled, ariaLabel }: {
  value: string;
  onChange: (isoDate: string) => void;
  placeholder: string;
  disablePast?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { t } = useI18n();
  const { locale, weekStartsOn, weekdays } = useCalendarPreferences();
  const [openState, setOpen] = React.useState(false);
  // A field that turns disabled while its calendar is open (an answer arrived
  // from another device) closes it, so nothing changes the frozen value.
  const open = openState && !disabled;
  if (disabled && openState) setOpen(false);
  const pick = (isoDate: string) => {
    if (!disabled) onChange(isoDate);
  };
  const todayDate = React.useMemo(() => startOfToday(), []);
  const selected = parseISODateToLocal(value);
  const [month, setMonth] = React.useState(() => startOfMonth(selected ?? todayDate));
  const atFirstMonth = disablePast && month.getTime() <= startOfMonth(todayDate).getTime();
  const selectedLabel = !selected ? '' : isSameCalendarDay(selected, todayDate)
    ? t('sessions.scheduledTasks.editor.date.today')
    : new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(selected);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        // It opens on the chosen month, wherever it was browsed to before.
        if (next) setMonth(startOfMonth(parseISODateToLocal(value) ?? todayDate));
        setOpen(next);
      }}
    >
      <Popover.Trigger
        disabled={disabled}
        render={<button type="button" aria-label={ariaLabel} className={cn(dropdownTriggerVariants({ size: 'default' }), 'w-fit max-w-full')} />}
      >
        <span className="inline-flex items-center gap-2">
          <Icon name="calendar" className="h-4 w-4 text-muted-foreground" />
          <span className="typography-ui-label text-foreground">{formatDateLabel(value, placeholder, locale)}</span>
        </span>
        <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup className={cn(dropdownMenuPopupClass, 'w-[288px] max-w-[calc(100vw-2rem)] p-3')} initialFocus={false}>
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => setMonth((previous) => shiftMonth(previous, -1))}
                aria-label={t('sessions.scheduledTasks.editor.date.previousMonth')}
                disabled={atFirstMonth}
              >
                <Icon name="arrow-left-s" className="h-4 w-4" />
              </button>
              <div className="typography-ui-label text-foreground">
                {new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month)}
              </div>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-interactive-hover"
                onClick={() => setMonth((previous) => shiftMonth(previous, 1))}
                aria-label={t('sessions.scheduledTasks.editor.date.nextMonth')}
              >
                <Icon name="arrow-right-s" className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-1 grid grid-cols-7 gap-1 px-1">
              {weekdays.map((weekday) => (
                <div key={weekday.value} className="py-1 text-center typography-micro text-muted-foreground">
                  {weekday.label}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {getCalendarCells(month, weekStartsOn).map(({ date, inCurrentMonth }) => {
                const isoDate = formatLocalDateISO(date);
                const isSelected = isoDate === value;
                const isToday = isSameCalendarDay(date, todayDate);
                const isPast = disablePast && date.getTime() < todayDate.getTime();
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
                      if (isPast) return;
                      pick(isoDate);
                      setOpen(false);
                    }}
                    disabled={isPast}
                    className={cn(
                      'h-8 rounded-md typography-ui-label',
                      dayClass,
                      isToday && !isSelected && 'ring-1 ring-inset ring-ring bg-interactive-selection text-interactive-selection-foreground',
                      isPast && 'cursor-not-allowed opacity-45',
                    )}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              <div className="typography-micro text-muted-foreground">{selectedLabel}</div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  pick(formatLocalDateISO(todayDate));
                  setMonth(startOfMonth(todayDate));
                }}
              >
                {t('sessions.scheduledTasks.editor.date.jumpToToday')}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
