import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cancelWhenLayoutSettled, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { cn } from '@/lib/utils';

export interface ToolbarAction {
  id: string;
  label: string;
  icon: IconName;
  onSelect?: () => void;
  onMenuSelect?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  done?: boolean;
  iconClassName?: string;
  menu?: React.ReactNode;
  pinned?: boolean;
  buttonAttributes?: Record<`data-${string}`, string>;
  shortcut?: string;
  destructive?: boolean;
}

export type ToolbarGroup = ReadonlyArray<ToolbarAction | null | false | undefined>;

const REST_CLASS = 'text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:text-foreground active:bg-transparent';
export const PRESSED_CLASS = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground active:bg-interactive-selection';

export function ToolbarButton({
  label,
  icon,
  pressed,
  done,
  iconClassName,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'children' | 'variant' | 'size'> & {
  label: string;
  icon: IconName;
  pressed?: boolean;
  done?: boolean;
  iconClassName?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={label}
      aria-pressed={pressed}
      className={cn('w-6 px-0 has-[>svg]:px-0', pressed ? PRESSED_CLASS : REST_CLASS, className)}
      {...props}
    >
      <Icon
        name={done ? 'check' : icon}
        className={cn('size-3.5', done ? 'text-[color:var(--status-success)]' : iconClassName)}
      />
    </Button>
  );
}

export function TooltipLabelWithShortcut({ label, shortcut }: { label: React.ReactNode; shortcut?: string }) {
  if (!shortcut) return <>{label}</>;
  return <span className="inline-flex items-center gap-2">{label}<span className="text-muted-foreground">{shortcut}</span></span>;
}

export function ButtonTooltip({ label, side, sideOffset = 6, className, children }: {
  label: React.ReactNode;
  side?: 'top' | 'bottom';
  sideOffset?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ToolbarTooltipButton({ label, shortcut, ...props }: React.ComponentProps<typeof ToolbarButton> & { shortcut?: string }) {
  return (
    <ButtonTooltip label={<TooltipLabelWithShortcut label={label} shortcut={shortcut} />} side="bottom">
      <ToolbarButton label={label} {...props} />
    </ButtonTooltip>
  );
}

const isAction = (action: ToolbarAction | null | false | undefined): action is ToolbarAction => Boolean(action);

const FOLD_ATTRIBUTE = 'data-folded';

const fits = (row: HTMLElement): boolean => row.scrollWidth <= row.clientWidth + 1;

const fitRow = (row: HTMLElement): string[] => {
  const items = Array.from(row.querySelectorAll<HTMLElement>('[data-toolbar-fold]'));
  const more = row.querySelector<HTMLElement>('[data-toolbar-more]');
  for (const item of items) item.removeAttribute(FOLD_ATTRIBUTE);
  const moreAlways = more?.dataset.toolbarMore === 'always';
  if (moreAlways) more?.removeAttribute(FOLD_ATTRIBUTE);
  else more?.setAttribute(FOLD_ATTRIBUTE, '');
  if (fits(row) || !more) return [];
  more.removeAttribute(FOLD_ATTRIBUTE);
  const folded: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    item.setAttribute(FOLD_ATTRIBUTE, '');
    folded.unshift(item.dataset.toolbarFold ?? '');
    if (fits(row)) break;
  }
  return folded;
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

export function ActionToolbar({
  groups,
  start,
  status,
  inline,
  trailing,
  menuOnly,
  fold = false,
  onMenuOpenChange,
  className,
}: {
  groups: ReadonlyArray<ToolbarGroup>;
  menuOnly?: ToolbarGroup;
  start?: React.ReactNode;
  status?: React.ReactNode;
  inline?: React.ReactNode;
  trailing?: ToolbarGroup;
  fold?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const [folded, setFolded] = React.useState<string[]>([]);

  const shownGroups = groups.map((group) => group.filter(isAction)).filter((group) => group.length > 0);
  const trailingActions = (trailing ?? []).filter(isAction);
  const menuOnlyActions = (menuOnly ?? []).filter(isAction);
  const signature = `${fold ? 1 : 0}\0${shownGroups.map((group) => group.map((action) => `${action.id}${action.pinned ? '!' : ''}`).join(',')).join('|')}\0${trailingActions.length}\0${menuOnlyActions.length}`;

  const refit = React.useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const next = fitRow(row);
    setFolded((current) => (sameIds(current, next) ? current : next));
  }, []);

  React.useLayoutEffect(() => {
    if (!fold) {
      setFolded((current) => (current.length === 0 ? current : []));
      return;
    }
    refit();
  }, [fold, refit, signature]);

  React.useEffect(() => {
    const row = rowRef.current;
    if (!fold || !row) return;
    const observer = new ResizeObserver(() => runWhenLayoutSettled(refit));
    observer.observe(row);
    for (const slot of row.querySelectorAll('[data-toolbar-measure]')) observer.observe(slot);
    return () => {
      observer.disconnect();
      cancelWhenLayoutSettled(refit);
    };
  }, [fold, refit, signature]);

  const renderButton = (action: ToolbarAction) => {
    const button = (
      <ToolbarTooltipButton
        label={action.label}
        icon={action.icon}
        pressed={action.pressed}
        done={action.done}
        disabled={action.disabled}
        iconClassName={action.iconClassName}
        shortcut={action.shortcut}
        onClick={action.onSelect}
        {...action.buttonAttributes}
      />
    );
    if (!action.menu) return button;
    return (
      <DropdownMenu onOpenChange={onMenuOpenChange}>
        <ButtonTooltip label={<TooltipLabelWithShortcut label={action.label} shortcut={action.shortcut} />} side="bottom">
          <DropdownMenuTrigger asChild>
            <ToolbarButton label={action.label} icon={action.icon} disabled={action.disabled} {...action.buttonAttributes} />
          </DropdownMenuTrigger>
        </ButtonTooltip>
        <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
          {action.menu}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const actionsById = new Map(shownGroups.flat().map((action) => [action.id, action]));
  const foldedActions = folded.map((id) => actionsById.get(id)).filter(isAction);
  const moreLabel = t('documentToolbar.moreActions');

  const renderMenuItem = (action: ToolbarAction) => action.menu ? (
    <DropdownMenuSub key={action.id}>
      <DropdownMenuSubTrigger className="flex items-center gap-2" disabled={action.disabled}>
        <Icon name={action.icon} className="size-4" />
        <span className="min-w-0 truncate typography-ui-label text-foreground">{action.label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56 max-h-[70vh] overflow-y-auto">
        {action.menu}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  ) : (
    <DropdownMenuItem
      key={action.id}
      className="flex items-center gap-2"
      variant={action.destructive ? 'destructive' : 'default'}
      disabled={action.disabled}
      onClick={action.onMenuSelect ?? action.onSelect}
      {...action.buttonAttributes}
    >
      <Icon name={action.icon} className={cn('size-4', action.iconClassName)} />
      <span className={cn('min-w-0 truncate typography-ui-label', !action.destructive && 'text-foreground')}>{action.label}</span>
      {action.shortcut ? <span className="ms-auto shrink-0 ps-3 typography-meta text-muted-foreground">{action.shortcut}</span> : null}
      {action.pressed ? <Icon name="check" className={cn('size-4 shrink-0 text-foreground', !action.shortcut && 'ms-auto')} /> : null}
    </DropdownMenuItem>
  );

  const more = fold || menuOnlyActions.length > 0 ? (
    <span data-toolbar-more={menuOnlyActions.length > 0 ? 'always' : ''} className="inline-flex data-[folded]:hidden">
      <DropdownMenu onOpenChange={onMenuOpenChange}>
        <ButtonTooltip label={moreLabel} side="bottom">
          <DropdownMenuTrigger asChild>
            <ToolbarButton label={moreLabel} icon="more" />
          </DropdownMenuTrigger>
        </ButtonTooltip>
        <DropdownMenuContent align="end" className="w-max min-w-56 max-w-80">
          {foldedActions.map(renderMenuItem)}
          {foldedActions.length > 0 && menuOnlyActions.length > 0 ? <DropdownMenuSeparator /> : null}
          {menuOnlyActions.map(renderMenuItem)}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  ) : null;

  return (
    <div ref={rowRef} className={cn('flex min-w-0 items-center gap-2.5', className)}>
      {start !== undefined ? <div className="flex min-w-0 flex-1 items-center">{start}</div> : null}
      {status ? <div data-toolbar-measure="" className="flex shrink-0 items-center">{status}</div> : null}
      {inline ? <div data-toolbar-measure="" className="flex shrink-0 items-center empty:hidden">{inline}</div> : null}
      {shownGroups.map((group, index) => (
        <div key={group[0].id} data-toolbar-group={index} className="flex shrink-0 items-center gap-0.5 [&:not(:has(>:not([data-folded])))]:hidden">
          {group.map((action) => (
            <span
              key={action.id}
              data-toolbar-fold={fold && !action.pinned ? action.id : undefined}
              className="inline-flex data-[folded]:hidden"
            >
              {renderButton(action)}
            </span>
          ))}
        </div>
      ))}
      {more || trailingActions.length > 0 ? (
        <div className="flex shrink-0 items-center gap-0.5 [&:not(:has(>:not([data-folded])))]:hidden">
          {more}
          {trailingActions.map((action) => <span key={action.id} className="inline-flex">{renderButton(action)}</span>)}
        </div>
      ) : null}
    </div>
  );
}
