import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useI18n } from '@/lib/i18n';
import { isNewSetting } from '@/lib/settings/newSettings';
import { isSettingsAnchorAvailable, type SettingsSearchAvailabilityContext } from '@/lib/settings/search';
import { cn } from '@/lib/utils';
import { SettingsInfoHint } from './SettingsInfoHint';

const SETTINGS_TRIGGER_WIDTH_CLASS = 'w-fit max-w-[28ch]';

export const SETTINGS_SELECT_TRIGGER_CLASS = SETTINGS_TRIGGER_WIDTH_CLASS;

export const SETTINGS_SELECT_ROW_TRIGGER_CLASS = SETTINGS_TRIGGER_WIDTH_CLASS;

export const SETTINGS_NUMBER_INPUT_CLASS = 'typography-ui-label w-[calc(5.75rem+5ch)]';

export const SETTINGS_ICON_BUTTON_CLASS =
  'h-8 w-8 px-0 text-muted-foreground hover:text-foreground';

// oxlint-disable-next-line react/only-export-components
export const SETTINGS_CUSTOM_TRIGGER_CLASS = cn(
  dropdownTriggerVariants(),
  SETTINGS_TRIGGER_WIDTH_CLASS,
);

export const SETTINGS_CONTROL_CLUSTER_CLASS = 'w-full max-w-[24rem]';

export const SETTINGS_NUMBER_STEPPER_ROW_CLASS = 'flex w-full min-w-0 items-center gap-2';

export const SETTINGS_NUMBER_UNIT_CLASS =
  'typography-meta shrink-0 text-muted-foreground tabular-nums';

export const SETTINGS_FIELDS_STACK_CLASS = 'space-y-4';

export const SETTINGS_OPTION_STACK_CLASS = 'space-y-1.5';

export const SETTINGS_PAGE_TITLE_CLASS =
  'typography-settings-page-title text-muted-foreground';
export const SETTINGS_SECTION_TITLE_CLASS =
  'typography-settings-section-title text-foreground';
const SETTINGS_GROUP_TITLE_CLASS =
  'typography-settings-group-title text-foreground';
export const SETTINGS_FIELD_LABEL_CLASS =
  'typography-settings-field-label text-foreground';
export const SETTINGS_DESCRIPTION_CLASS =
  'typography-settings-description text-muted-foreground';
export const SETTINGS_HELPER_CLASS = 'typography-meta text-muted-foreground';
export const SETTINGS_CALLOUT_TITLE_CLASS = 'typography-meta font-medium text-foreground';
export const SETTINGS_BRAND_TITLE_CLASS =
  'typography-settings-section-title text-foreground';

export const SettingsBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">
    {children}
  </span>
);

const SettingsAvailabilityContext = React.createContext<SettingsSearchAvailabilityContext | null>(null);
export const SettingsAvailabilityProvider = SettingsAvailabilityContext.Provider;

export const SettingsNewBadge: React.FC<{ items: readonly (string | undefined)[] }> = ({ items }) => {
  const { t } = useI18n();
  const ctx = React.useContext(SettingsAvailabilityContext);
  if (!ctx || !items.some((item) => item != null && isNewSetting(item) && isSettingsAnchorAvailable(item, ctx))) return null;
  return <SettingsBadge>{t('settings.view.badge.new')}</SettingsBadge>;
};

interface SettingsSectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  titleAccessory?: React.ReactNode;
  info?: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  divider?: boolean;
  className?: string;
  contentClassName?: string;
  settingsItem?: string;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  titleAccessory,
  info,
  headerAction,
  children,
  divider = false,
  className,
  contentClassName,
  settingsItem,
}) => {
  const hasHeader = title != null || description != null || headerAction != null || info != null;

  return (
    <section
      data-settings-item={settingsItem}
      className={cn(
        'space-y-5 pt-10 first:pt-0',
        divider && 'border-t border-edge',
        className,
      )}
    >
      {hasHeader ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            {title != null ? (
              <div className={cn('flex items-center gap-2', headerAction != null && 'min-h-7')}>
                {typeof title === 'string' || typeof title === 'number' ? (
                  <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{title}</h2>
                ) : (
                  title
                )}
                <SettingsNewBadge items={[settingsItem]} />
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
  info?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  settingsItem?: string;
}

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
              <SettingsNewBadge items={[settingsItem]} />
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
  info?: React.ReactNode;
  descriptionPlacement?: 'before' | 'after';
  children: React.ReactNode;
  settingsItem?: string;
  className?: string;
  controlClassName?: string;
}

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
          <SettingsNewBadge items={[settingsItem]} />
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
  info?: React.ReactNode;
  children: React.ReactNode;
  settingsItem?: string;
  className?: string;
  controlClassName?: string;
  labelAccessory?: React.ReactNode;
  alignEnd?: boolean;
}

export const SettingsFieldRow: React.FC<SettingsFieldRowProps> = ({
  label,
  description,
  info,
  children,
  settingsItem,
  className,
  controlClassName,
  labelAccessory,
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
          <SettingsNewBadge items={[settingsItem]} />
          {labelAccessory}
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
  info?: React.ReactNode;
  footer?: React.ReactNode;
}

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
        className={hasDescription ? 'mt-0.5 self-start' : undefined}
      />
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn(SETTINGS_FIELD_LABEL_CLASS, disabled && 'opacity-60')}>{label}</span>
          <SettingsNewBadge items={[settingsItem]} />
          {labelAccessory}
          {info != null ? <SettingsInfoHint>{info}</SettingsInfoHint> : null}
        </div>
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
  selectedClassName?: string;
  tooltip?: React.ReactNode;
}

interface SettingsChipGroupProps<T extends string> {
  value: T;
  options: Array<SettingsChipOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  'aria-label'?: string;
}

const ChipTooltip: React.FC<{
  disabled?: boolean;
  content: React.ReactNode;
  children: React.ReactElement;
}> = ({ disabled, content, children }) => {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLSpanElement | null>(null);
  const popupRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open || !disabled) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (triggerRef.current?.contains(event.target) || popupRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress, true);
  }, [disabled, open]);

  const popup = (
    <TooltipContent side="top" sideOffset={6} className="max-w-xs">
      <div ref={popupRef}>{content}</div>
    </TooltipContent>
  );
  if (!disabled) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        {popup}
      </Tooltip>
    );
  }
  return (
    <Tooltip delayDuration={0} open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        onPointerDown={(event) => event.preventBaseUIHandler()}
        onClick={(event) => {
          event.preventBaseUIHandler();
          setOpen(true);
        }}
      >
        <span ref={triggerRef} className="inline-flex" tabIndex={0}>{children}</span>
      </TooltipTrigger>
      {popup}
    </Tooltip>
  );
};

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
                ? option.selectedClassName
                  ?? 'oc-raised bg-[var(--surface-background)] text-foreground hover:bg-[var(--surface-background)] dark:bg-[var(--surface-elevated)] dark:hover:bg-[var(--surface-elevated)]'
                : 'text-muted-foreground hover:bg-transparent hover:text-foreground',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        );
        if (!option.tooltip) return chip;
        return (
          <ChipTooltip key={option.value} disabled={option.disabled} content={option.tooltip}>
            {chip}
          </ChipTooltip>
        );
      })}
    </div>
  );
}
