import { isMultiLineTimelineContext, type SessionSidebarRenderContext } from '../sessionSidebarRowModel';

export const resolveSessionRowLines = (renderContext: SessionSidebarRenderContext, detailed: boolean) => {
  const isOneLineTimelineRow = renderContext === 'tree-chat' || renderContext === 'mixed-compact';
  const isDetailedTreeRow = detailed && renderContext === 'project';
  const isTwoLineRow = isMultiLineTimelineContext(renderContext) || isDetailedTreeRow;
  const isTimelineRow = isTwoLineRow || isOneLineTimelineRow;
  const isZoneRow = renderContext === 'timeline-mixed' || renderContext === 'mixed-compact';
  return { isOneLineTimelineRow, isTwoLineRow, isTimelineRow, isZoneRow };
};

type SessionRowActionLayoutInput = {
  isVSCode: boolean;
  alwaysShowActions: boolean;
  archivedBucket: boolean;
  mobileVariant: boolean;
  canTrackWork: boolean;
  isTimelineRow: boolean;
  isOneLineTimelineRow: boolean;
  isSessionMenuOpen: boolean;
  endBadgeCount?: 0 | 1 | 2;
};

const END_BADGE_ACTIONS_INSET_CLASS = [
  'inset-e-1',
  'inset-e-[calc(1.625rem*var(--padding-scale,1))]',
  'inset-e-[calc(2.625rem*var(--padding-scale,1))]',
] as const;
const ONE_LINE_ACTIONS_RESERVE_CLASS = [
  ['[--oc-actions-reserve:0.625rem]', '[--oc-actions-reserve:1.75rem]', '[--oc-actions-reserve:2.875rem]', '[--oc-actions-reserve:4rem]'],
  ['[--oc-actions-reserve:2rem]', '[--oc-actions-reserve:3.125rem]', '[--oc-actions-reserve:4.25rem]', '[--oc-actions-reserve:5.375rem]'],
  ['[--oc-actions-reserve:3rem]', '[--oc-actions-reserve:4.125rem]', '[--oc-actions-reserve:5.25rem]', '[--oc-actions-reserve:6.375rem]'],
] as const;
const VSCODE_END_BADGE_ACTIONS_ROOM_CLASS = {
  hover: [
    'group-hover:pe-[calc(1.75rem*var(--padding-scale,1))]',
    'group-hover:pe-[calc(3.375rem*var(--padding-scale,1))]',
    'group-hover:pe-[calc(5rem*var(--padding-scale,1))]',
    'group-hover:pe-[calc(6.625rem*var(--padding-scale,1))]',
  ],
  open: [
    'pe-[calc(1.75rem*var(--padding-scale,1))]',
    'pe-[calc(3.375rem*var(--padding-scale,1))]',
    'pe-[calc(5rem*var(--padding-scale,1))]',
    'pe-[calc(6.625rem*var(--padding-scale,1))]',
  ],
} as const;

export const resolveSessionRowActionLayout = ({
  isVSCode,
  alwaysShowActions,
  archivedBucket,
  mobileVariant,
  canTrackWork,
  isTimelineRow,
  isOneLineTimelineRow,
  isSessionMenuOpen,
  endBadgeCount = 0,
}: SessionRowActionLayoutInput) => {
  const revealOnHoverClass = isVSCode
    ? 'group-hover:opacity-100 group-hover:pointer-events-auto'
    : 'group-hover:opacity-100 group-hover:pointer-events-auto group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:pointer-events-auto';
  const hideOnHoverClass = isVSCode
    ? 'group-hover:opacity-0'
    : 'group-hover:opacity-0 group-has-[:focus-visible]:opacity-0';
  const showOpenInEditorAction = isVSCode;
  const showQuickArchiveAction = !archivedBucket && !mobileVariant;
  const showWorkAction = canTrackWork && !alwaysShowActions;
  const extraHoverActions = (showWorkAction ? 1 : 0) + (showQuickArchiveAction ? 1 : 0) + (showOpenInEditorAction ? 1 : 0);
  const showMenuButton = alwaysShowActions;
  const hoverButtons = extraHoverActions + (showMenuButton ? 1 : 0);
  const vscodeAlwaysActionPaddingClass = hoverButtons === 0 ? undefined : ['group-hover:pe-8', 'group-hover:pe-14', 'group-hover:pe-18', 'group-hover:pe-22'][hoverButtons - 1];
  const alwaysActionPaddingClass = showQuickArchiveAction ? 'pe-13' : 'pe-7';
  const actionsReserveClass = hoverButtons === 0
    ? undefined
    : isTimelineRow && !isOneLineTimelineRow
      ? ['[--oc-actions-reserve:0.875rem]', '[--oc-actions-reserve:2.25rem]', '[--oc-actions-reserve:3.625rem]', '[--oc-actions-reserve:5rem]'][hoverButtons - 1]
      : ONE_LINE_ACTIONS_RESERVE_CLASS[endBadgeCount][hoverButtons - 1];
  const actionsInsetClass = END_BADGE_ACTIONS_INSET_CLASS[isTimelineRow && !isOneLineTimelineRow ? 0 : endBadgeCount];
  const endBadgeActionsRoomClass = isVSCode && alwaysShowActions && endBadgeCount > 0 && hoverButtons > 0
    ? VSCODE_END_BADGE_ACTIONS_ROOM_CLASS[isSessionMenuOpen ? 'open' : 'hover'][hoverButtons - 1]
    : undefined;
  const actionsMaskClass = alwaysShowActions || hoverButtons === 0
    ? undefined
    : isSessionMenuOpen
      ? 'oc-actions-mask'
      : isVSCode
        ? 'group-hover:oc-actions-mask'
        : 'group-hover:oc-actions-mask group-has-[:focus-visible]:oc-actions-mask';
  const coveredMetaFadeClass = hoverButtons === 0 ? '' : isSessionMenuOpen ? 'opacity-0' : hideOnHoverClass;
  const actionButtonSizeClass = alwaysShowActions ? 'h-6 w-6' : isTimelineRow && !isOneLineTimelineRow ? 'h-5 w-5' : 'h-4 w-4';
  const actionIconSizeClass = alwaysShowActions ? 'h-3.5 w-3.5' : isTimelineRow && !isOneLineTimelineRow ? 'h-3 w-3' : 'h-2.5 w-2.5';
  const checkIconSizeClass = alwaysShowActions ? 'h-4 w-4' : isTimelineRow && !isOneLineTimelineRow ? 'h-3.5 w-3.5' : 'h-3 w-3';
  return {
    revealOnHoverClass,
    showOpenInEditorAction,
    showQuickArchiveAction,
    showWorkAction,
    vscodeAlwaysActionPaddingClass,
    alwaysActionPaddingClass,
    actionsReserveClass,
    actionsInsetClass,
    endBadgeActionsRoomClass,
    actionsMaskClass,
    coveredMetaFadeClass,
    actionButtonSizeClass,
    actionIconSizeClass,
    checkIconSizeClass,
  };
};
