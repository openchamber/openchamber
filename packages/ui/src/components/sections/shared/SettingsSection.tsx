import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { cn } from '@/lib/utils';
import { SettingsInfoHint } from './SettingsInfoHint';

/**
 * Width cap shared by every settings value picker.
 *
 * `applyTypography` scales the `--typography-*` vars but never the root rem,
 * so a rem-based cap (`max-w-48`) stays 192px while the label inside it grows,
 * and the value clips at 150–200% interface font size. `ch` is measured
 * against the trigger's own `typography-ui-label` font, so the cap grows with
 * the setting.
 *
 * A trigger hugs its value, the chevron right after it, so a short value is a
 * short button rather than a wide box with the chevron pushed to its edge.
 * The cap keeps a long value from stretching across the pane; it truncates.
 */
const SETTINGS_TRIGGER_WIDTH_CLASS = 'w-fit max-w-[28ch]';

/** Settings select trigger in stacked cells. */
export const SETTINGS_SELECT_TRIGGER_CLASS = SETTINGS_TRIGGER_WIDTH_CLASS;

/** Settings select trigger in SettingsFieldRow control columns. */
export const SETTINGS_SELECT_ROW_TRIGGER_CLASS = SETTINGS_TRIGGER_WIDTH_CLASS;

/**
 * Width for every settings NumberInput stepper. Font-relative for the same
 * reason as the trigger cap above: a rem-fixed `w-16`/`w-20`/`w-24`/`w-32`
 * clips its own digits once the interface font is scaled up. The explicit
 * `typography-ui-label` pins `ch` to the same scaled font the inner numeric
 * field renders in, since the wrapper would otherwise inherit an unscaled one.
 */
export const SETTINGS_NUMBER_INPUT_CLASS = 'typography-ui-label w-[16ch]';

/** Compact reset / icon action next to a settings control (matches h-8 controls). */
export const SETTINGS_ICON_BUTTON_CLASS =
  'h-8 w-8 px-0 text-muted-foreground hover:text-foreground';

/** Custom dropdown triggers (ModelSelector / AgentSelector) in settings field rows. */
// oxlint-disable-next-line react/only-export-components
export const SETTINGS_CUSTOM_TRIGGER_CLASS = cn(
  dropdownTriggerVariants(),
  SETTINGS_TRIGGER_WIDTH_CLASS,
);

/** Shared width for stacked control clusters (select/input + reset). */
export const SETTINGS_CONTROL_CLUSTER_CLASS = 'w-full max-w-[24rem]';

/** Fill a control cluster the same way as a full-width select. */
export const SETTINGS_CLUSTER_CONTROL_CLASS = 'min-w-0 flex-1';

/**
 * Row wrapping a NumberInput + unit label + reset.
 * Keep the stepper intrinsic — never flex-grow it or +/- buttons stretch unevenly.
 */
export const SETTINGS_NUMBER_STEPPER_ROW_CLASS = 'flex w-full min-w-0 items-center gap-2';

/** Unit suffix next to a settings number stepper (%, px, …). */
export const SETTINGS_NUMBER_UNIT_CLASS =
  'typography-meta shrink-0 text-muted-foreground tabular-nums';

/** Vertical stack spacing for fields inside a column. */
export const SETTINGS_FIELDS_STACK_CLASS = 'space-y-4';

/** Compact checkbox / radio list stack. */
export const SETTINGS_OPTION_STACK_CLASS = 'space-y-1.5';

/**
 * Settings heading classes by context (size + default color).
 * Prefer these over ad-hoc typography-* + color combinations.
 */
/** L1 — page / detail-pane title (larger, quieter than section titles). */
export const SETTINGS_PAGE_TITLE_CLASS =
  'typography-settings-page-title text-muted-foreground';
/** L2 — section title inside a settings page. */
export const SETTINGS_SECTION_TITLE_CLASS =
  'typography-settings-section-title text-foreground';
/** L3 — control-group heading inside a section. */
const SETTINGS_GROUP_TITLE_CLASS =
  'typography-settings-group-title text-foreground';
/** L4 — field / control labels. */
export const SETTINGS_FIELD_LABEL_CLASS =
  'typography-settings-field-label text-foreground';
/** Supporting copy under page or section titles. */
export const SETTINGS_DESCRIPTION_CLASS =
  'typography-settings-description text-muted-foreground';
/** Supporting copy under group titles and fields. */
export const SETTINGS_HELPER_CLASS = 'typography-meta text-muted-foreground';
/** Callout / alert headline inside a section (not a control-group title). */
export const SETTINGS_CALLOUT_TITLE_CLASS = 'typography-meta font-medium text-foreground';
/** Brand / product name under a logo — quieter than L1 page title. */
export const SETTINGS_BRAND_TITLE_CLASS =
  'typography-settings-section-title text-foreground';

interface SettingsSectionProps {
  /** Section title. Strings render as the shared h2 style. */
  title?: React.ReactNode;
  /** Optional supporting text under the title. */
  description?: React.ReactNode;
  /** Optional icon/badge next to the title. */
  titleAccessory?: React.ReactNode;
  /** Helper text hidden behind an info icon next to the title. */
  info?: React.ReactNode;
  /** Optional action aligned to the right of the header. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Show a top border divider.
   * Use `false` for the first section under the page header.
   * @default true
   */
  divider?: boolean;
  className?: string;
  contentClassName?: string;
  settingsItem?: string;
}

/**
 * Shared settings section chrome: single-style header + optional divider.
 */
export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  titleAccessory,
  info,
  headerAction,
  children,
  divider = true,
  className,
  contentClassName,
  settingsItem,
}) => {
  const hasHeader = title != null || description != null || headerAction != null || info != null;

  return (
    <section
      data-settings-item={settingsItem}
      className={cn(
        'space-y-5',
        divider ? 'border-t border-border/60 py-8' : 'pb-8',
        className,
      )}
    >
      {hasHeader ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            {title != null ? (
              <div className="flex items-center gap-2">
                {typeof title === 'string' || typeof title === 'number' ? (
                  <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{title}</h2>
                ) : (
                  title
                )}
                {titleAccessory}
                {info != null ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
              </div>
            ) : null}
            {description != null ? (
              <div className={SETTINGS_DESCRIPTION_CLASS}>{description}</div>
            ) : null}
          </div>
          {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
        </div>
      ) : null}
      <div className={cn(contentClassName)}>{children}</div>
    </section>
  );
};

interface SettingsTwoColumnProps {
  children: React.ReactNode;
  className?: string;
}

/** Responsive two-column settings grid used when space allows. */
export const SettingsTwoColumn: React.FC<SettingsTwoColumnProps> = ({
  children,
  className,
}) => {
  return (
    <div className={cn('grid grid-cols-1 gap-6 @3xl:grid-cols-2 @3xl:gap-10', className)}>
      {children}
    </div>
  );
};

interface SettingsGroupTitleProps {
  children: React.ReactNode;
  className?: string;
  as?: 'h2' | 'h3' | 'div';
}

/** In-section control-group heading (quieter than SettingsSection title). */
export const SettingsGroupTitle: React.FC<SettingsGroupTitleProps> = ({
  children,
  className,
  as: Tag = 'h3',
}) => {
  return (
    <Tag className={cn(SETTINGS_GROUP_TITLE_CLASS, className)}>
      {children}
    </Tag>
  );
};

interface SettingsControlGroupProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Helper text hidden behind an info icon next to the group title. */
  info?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  settingsItem?: string;
}

/** Labeled control cluster inside a section (radios, chips, stacked fields). */
export const SettingsControlGroup: React.FC<SettingsControlGroupProps> = ({
  title,
  description,
  info,
  children,
  className,
  contentClassName,
  settingsItem,
}) => {
  return (
    <div data-settings-item={settingsItem} className={cn('space-y-2', className)}>
      {title != null || description != null || info != null ? (
        <div className="space-y-0.5">
          {title != null ? (
            <div className="flex items-center gap-1.5">
              <SettingsGroupTitle>{title}</SettingsGroupTitle>
              {info != null ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
            </div>
          ) : null}
          {description != null ? (
            <p className={SETTINGS_HELPER_CLASS}>{description}</p>
          ) : null}
        </div>
      ) : null}
      <div className={cn(contentClassName)}>{children}</div>
    </div>
  );
};

interface SettingsStackedFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Helper text hidden behind an info icon next to the label. */
  info?: React.ReactNode;
  /** Where helper text sits relative to the control. @default 'before' */
  descriptionPlacement?: 'before' | 'after';
  children: React.ReactNode;
  settingsItem?: string;
  className?: string;
  controlClassName?: string;
}

/**
 * Label (+ optional description) above a control — for two-column cells.
 * Prefer this over SettingsFieldRow inside SettingsTwoColumn (FieldRow overflows half-width columns).
 */
export const SettingsStackedField: React.FC<SettingsStackedFieldProps> = ({
  label,
  description,
  info,
  descriptionPlacement = 'before',
  children,
  settingsItem,
  className,
  controlClassName,
}) => {
  const descriptionNode =
    description != null ? (
      <p className={SETTINGS_HELPER_CLASS}>{description}</p>
    ) : null;

  return (
    <div data-settings-item={settingsItem} className={cn('space-y-2', className)}>
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <div className={SETTINGS_FIELD_LABEL_CLASS}>{label}</div>
          {info != null ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
        </div>
        {descriptionPlacement === 'before' ? descriptionNode : null}
      </div>
      <div className={cn('flex min-w-0 max-w-[24rem] items-center gap-2', controlClassName)}>{children}</div>
      {descriptionPlacement === 'after' ? descriptionNode : null}
    </div>
  );
};

interface SettingsFieldRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Helper text hidden behind an info icon next to the label. */
  info?: React.ReactNode;
  children: React.ReactNode;
  settingsItem?: string;
  className?: string;
  controlClassName?: string;
  /** Align control to the trailing edge on desktop. @default true */
  alignEnd?: boolean;
}

/**
 * Side-by-side form row: fixed label column + control cluster.
 * Use inside full-width sections or single columns.
 *
 * The row's own vertical padding keeps two stacked rows of 32px controls
 * apart (8px between them), so a list of field rows needs no spacing of its
 * own and labels keep one rhythm whatever control sits beside them.
 */
export const SettingsFieldRow: React.FC<SettingsFieldRowProps> = ({
  label,
  description,
  info,
  children,
  settingsItem,
  className,
  controlClassName,
  alignEnd = true,
}) => {
  return (
    <div
      data-settings-item={settingsItem}
      className={cn(
        'flex flex-col gap-2 py-1 @xl:flex-row @xl:items-center @xl:gap-8',
        className,
      )}
    >
      <div className="min-w-0 @xl:w-56 @xl:shrink-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className={cn('min-w-0 truncate', SETTINGS_FIELD_LABEL_CLASS)}>{label}</div>
          {info != null ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
        </div>
        {description != null ? (
          <p className={cn(SETTINGS_HELPER_CLASS, 'mt-0.5')}>{description}</p>
        ) : null}
      </div>
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 @xl:w-fit @xl:flex-none',
          alignEnd && '@xl:justify-end',
          controlClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
};

interface SettingsInsetProps {
  children: React.ReactNode;
  className?: string;
  settingsItem?: string;
}

/** Optional inset block under a section (spacing only; section dividers own borders). */
export const SettingsInset: React.FC<SettingsInsetProps> = ({
  children,
  className,
  settingsItem,
}) => {
  return (
    <div
      data-settings-item={settingsItem}
      className={cn('pt-4', className)}
    >
      {children}
    </div>
  );
};

interface SettingsCheckboxRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  settingsItem?: string;
  className?: string;
  labelAccessory?: React.ReactNode;
  /** Helper text hidden behind an info icon next to the label. */
  info?: React.ReactNode;
  /**
   * A line under the label that holds its own controls (a link). It sits
   * outside the clickable row, so the link is not a button inside a button,
   * and lines up with the label.
   */
  footer?: React.ReactNode;
}

/** Shared checkbox setting row with keyboard support. */
export const SettingsCheckboxRow: React.FC<SettingsCheckboxRowProps> = ({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  ariaLabel,
  settingsItem,
  className,
  labelAccessory,
  info,
  footer,
}) => {
  const toggle = () => {
    if (!disabled) onChange(!checked);
  };

  const hasDescription = description != null;

  const row = (
    <div
      data-settings-item={footer != null ? undefined : settingsItem}
      className={cn(
        'group flex cursor-pointer gap-2 py-0.5',
        hasDescription ? 'items-start' : 'items-center',
        disabled && 'cursor-not-allowed',
        className,
      )}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={checked}
      aria-disabled={disabled || undefined}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          toggle();
        }
      }}
    >
      <Checkbox
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={ariaLabel}
        // With a description below, the box lines up with the label's line
        // rather than the middle of both lines.
        className={hasDescription ? 'mt-0.5 self-start' : undefined}
      />
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn(SETTINGS_FIELD_LABEL_CLASS, disabled && 'opacity-60')}>{label}</span>
          {labelAccessory}
          {info != null ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
        </div>
        {/* A description stays at full strength on a disabled row: it is
            usually what says why the option is off and how to turn it on. */}
        {hasDescription ? (
          <span className={SETTINGS_HELPER_CLASS}>{description}</span>
        ) : null}
      </div>
    </div>
  );

  if (footer == null) return row;
  return (
    <div data-settings-item={settingsItem}>
      {row}
      {/* Checkbox (16px) plus the row's gap (8px): the footer starts under the label. */}
      <div className="ps-6">{footer}</div>
    </div>
  );
};

interface SettingsRadioOptionProps {
  selected: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/** Single radio option row used inside SettingsRadioGroup. */
export const SettingsRadioOption: React.FC<SettingsRadioOptionProps> = ({
  selected,
  onSelect,
  label,
  description,
  ariaLabel,
  disabled = false,
  className,
}) => {
  return (
    <div
      className={cn(
        'flex cursor-pointer gap-2 py-0.5',
        description != null ? 'items-start' : 'items-center',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={selected}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          if (!disabled) onSelect();
        }
      }}
    >
      <Radio
        checked={selected}
        onChange={onSelect}
        disabled={disabled}
        ariaLabel={ariaLabel}
        className={description != null ? 'mt-0.5' : undefined}
      />
      <div className="flex min-w-0 flex-col">
        <span
          className="typography-settings-field-label font-normal text-foreground"
        >
          {label}
        </span>
        {description != null ? (
          <span className={SETTINGS_HELPER_CLASS}>{description}</span>
        ) : null}
      </div>
    </div>
  );
};

interface SettingsRadioGroupProps {
  'aria-label': string;
  children: React.ReactNode;
  className?: string;
}

/** Accessible radio group wrapper with compact vertical spacing. */
export const SettingsRadioGroup: React.FC<SettingsRadioGroupProps> = ({
  'aria-label': ariaLabel,
  children,
  className,
}) => {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn(SETTINGS_OPTION_STACK_CLASS, className)}>
      {children}
    </div>
  );
};

interface SettingsChipOption<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  /**
   * Shown on hover (long-press on touch). The popup stays open while the
   * pointer is on it, so it may carry a link. Keep what the user must read
   * visible elsewhere: touch users rarely long-press.
   */
  tooltip?: React.ReactNode;
}

interface SettingsChipGroupProps<T extends string> {
  value: T;
  options: Array<SettingsChipOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  'aria-label'?: string;
}

/**
 * Compact segmented enum picker, drawn like the active-pill tab strip: the
 * options sit in a recessed track and the chosen one is raised out of it.
 * The track is as tall as the other settings controls (32px), so a row with
 * chips lines up with a row holding a select or a stepper.
 */
export function SettingsChipGroup<T extends string>({
  value,
  options,
  onChange,
  className,
  'aria-label': ariaLabel,
}: SettingsChipGroupProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'oc-recessed inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const selected = value === option.value;
        const chip = (
          <Button
            key={option.value}
            type="button"
            variant="ghost"
            size="sm"
            disabled={option.disabled}
            aria-pressed={selected}
            className={cn(
              'rounded-md !font-normal',
              selected
                // Light themes paint elevated darker than the canvas, so the
                // raised option takes the canvas colour there, like the tab pill.
                ? 'oc-raised bg-[var(--surface-background)] text-foreground hover:bg-[var(--surface-background)] dark:bg-[var(--surface-elevated)] dark:hover:bg-[var(--surface-elevated)]'
                : 'text-muted-foreground hover:bg-transparent hover:text-foreground',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        );
        if (!option.tooltip) return chip;
        return (
          <Tooltip key={option.value}>
            {/* A disabled button gets no hover events, so its tooltip (usually
                the reason it is disabled) hangs on a wrapper instead. */}
            <TooltipTrigger asChild>
              {option.disabled ? <span className="inline-flex" tabIndex={0}>{chip}</span> : chip}
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-xs">
              {option.tooltip}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
