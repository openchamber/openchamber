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

/**
 * One icon action of a toolbar row. A toggle sets `pressed`; its label names
 * the option ("Wrap lines"), never what the next click does, because the fill
 * already says whether it is on.
 */
export interface ToolbarAction {
  id: string;
  label: string;
  icon: IconName;
  onSelect?: () => void;
  /** Picked from the "More actions" menu, where a check after the click is never seen. Defaults to `onSelect`. */
  onMenuSelect?: () => void;
  /** A toggle: on draws the selection fill on the button and a check in the menu. */
  pressed?: boolean;
  disabled?: boolean;
  /** A check stands in for the icon for a moment after the action worked. */
  done?: boolean;
  /** The icon's colour while something it started runs (read aloud). */
  iconClassName?: string;
  /** Items of a menu the button opens; in "More actions" they become a submenu. */
  menu?: React.ReactNode;
  /** Never moves into "More actions". */
  pinned?: boolean;
  /** Attributes on the button, for code that recognises it (outside-click checks). */
  buttonAttributes?: Record<`data-${string}`, string>;
  /** The action's keyboard shortcut as the shortcuts dialog writes it (`formatShortcutForDisplay`), shown in its tooltip and menu item. */
  shortcut?: string;
}

/** Actions that belong together, set apart from the next group by space. */
export type ToolbarGroup = ReadonlyArray<ToolbarAction | null | false | undefined>;

const REST_CLASS = 'text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:text-foreground active:bg-transparent';
/** The toggle-on fill, shared with the markdown wrap toggles that keep their own geometry. */
export const PRESSED_CLASS = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground active:bg-interactive-selection';

/**
 * The 24px icon button every toolbar row shares. Three looks: an action rests
 * muted and brightens on hover, a toggle that is on carries the selection
 * fill, a disabled one fades. Hover changes colour only, so a row of them
 * never flickers fills under the pointer.
 */
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

/** A label with its keyboard shortcut after it, muted, for a tooltip. */
export function TooltipLabelWithShortcut({ label, shortcut }: { label: React.ReactNode; shortcut?: string }) {
  if (!shortcut) return <>{label}</>;
  return <span className="inline-flex items-center gap-2">{label}<span className="text-muted-foreground">{shortcut}</span></span>;
}

/** A `ToolbarButton` with its tooltip, which opens below so it never covers the row. */
export function ToolbarTooltipButton({ label, shortcut, ...props }: React.ComponentProps<typeof ToolbarButton> & { shortcut?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The span keeps the tooltip on a disabled button, which takes no pointer events. */}
        <span className="inline-flex">
          <ToolbarButton label={label} {...props} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}><TooltipLabelWithShortcut label={label} shortcut={shortcut} /></TooltipContent>
    </Tooltip>
  );
}

const isAction = (action: ToolbarAction | null | false | undefined): action is ToolbarAction => Boolean(action);

const FOLD_ATTRIBUTE = 'data-folded';

const fits = (row: HTMLElement): boolean => row.scrollWidth <= row.clientWidth + 1;

/**
 * Folds actions into "More actions" from the end of the row while it does not
 * fit, and returns which ones it folded. Attributes are set on the DOM
 * directly: React never renders `data-folded`, so a render cannot undo a fit,
 * and the fit needs no render per step.
 */
const fitRow = (row: HTMLElement): string[] => {
  const items = Array.from(row.querySelectorAll<HTMLElement>('[data-toolbar-fold]'));
  const more = row.querySelector<HTMLElement>('[data-toolbar-more]');
  for (const item of items) item.removeAttribute(FOLD_ATTRIBUTE);
  // A menu with items of its own stays; an empty one shows only once something folds.
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

/**
 * A row of icon actions over a document: the Files editor, a plan, a page or
 * diagram in the chat.
 *
 * Groups sit apart by space. `start` (a file path) takes the free width and
 * gives it up first; with `fold`, actions that still do not fit move into
 * "More actions" from the end of the row, while pinned ones and `trailing`
 * (full screen) stay. `status` holds a slot whose width the caller keeps
 * steady, such as save state.
 *
 * The set of actions a caller passes should depend on what the document is,
 * never on its mode: an action that works in one mode only switches to it,
 * so changing modes moves no button.
 */
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
  /** Settings of the document that live in "More actions" only, after whatever folded. */
  menuOnly?: ToolbarGroup;
  start?: React.ReactNode;
  status?: React.ReactNode;
  /** Shown before the groups while open, such as an inline go-to-line field. */
  inline?: React.ReactNode;
  trailing?: ToolbarGroup;
  fold?: boolean;
  /** Each menu the row opens reports here, so a caller can hold focus handling while one is open. */
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
    // A side column's animation resizes the row on every frame: fit once, at its end.
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
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <DropdownMenuTrigger asChild>
                <ToolbarButton label={action.label} icon={action.icon} disabled={action.disabled} {...action.buttonAttributes} />
              </DropdownMenuTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}><TooltipLabelWithShortcut label={action.label} shortcut={action.shortcut} /></TooltipContent>
        </Tooltip>
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
      disabled={action.disabled}
      onClick={action.onMenuSelect ?? action.onSelect}
    >
      <Icon name={action.icon} className={cn('size-4', action.iconClassName)} />
      <span className="min-w-0 truncate typography-ui-label text-foreground">{action.label}</span>
      {action.shortcut ? <span className="ms-auto shrink-0 ps-3 typography-meta text-muted-foreground">{action.shortcut}</span> : null}
      {action.pressed ? <Icon name="check" className={cn('size-4 shrink-0 text-foreground', !action.shortcut && 'ms-auto')} /> : null}
    </DropdownMenuItem>
  );

  const more = fold || menuOnlyActions.length > 0 ? (
    <span data-toolbar-more={menuOnlyActions.length > 0 ? 'always' : ''} className="inline-flex data-[folded]:hidden">
      <DropdownMenu onOpenChange={onMenuOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <DropdownMenuTrigger asChild>
                <ToolbarButton label={moreLabel} icon="more" />
              </DropdownMenuTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{moreLabel}</TooltipContent>
        </Tooltip>
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
        // A group whose every action folded takes no gap.
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
