import { isMultiLineTimelineContext, type SessionSidebarRenderContext } from '../sessionSidebarRowModel';

/**
 * Which row shape a session row takes in its render context. Chats and the
 * rows of zones that mix projects are one line, with the tree's slot left of
 * the title for the state and the chevron. Detailed rows are two lines with
 * no slot: the state sits on the right and the chevron takes the place of the
 * second line's first icon on hover.
 */
export const resolveSessionRowLines = (renderContext: SessionSidebarRenderContext, detailed: boolean) => {
  const isOneLineTimelineRow = renderContext === 'tree-chat' || renderContext === 'mixed-compact';
  // A work under its project with Detailed rows on takes the detailed row's
  // two lines too.
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
};

/** The classes and counts that place a row's hover-revealed actions and make room for them. */
export const resolveSessionRowActionLayout = ({
  isVSCode,
  alwaysShowActions,
  archivedBucket,
  mobileVariant,
  canTrackWork,
  isTimelineRow,
  isOneLineTimelineRow,
  isSessionMenuOpen,
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
  // Hover-revealed actions besides the menu: work, quick archive, and in VS
  // Code open-in-editor.
  const extraHoverActions = (showWorkAction ? 1 : 0) + (showQuickArchiveAction ? 1 : 0) + (showOpenInEditorAction ? 1 : 0);
  // With a mouse the row's menu is its right-click menu (Shift+F10 from the
  // keyboard), so the ⋯ button shows on touch only: always in touch layouts,
  // and on hover for a touch screen elsewhere (`pointer-fine:hidden`). Hover
  // reserves are for a mouse, so they count it only where it always shows.
  const showMenuButton = alwaysShowActions;
  const hoverButtons = extraHoverActions + (showMenuButton ? 1 : 0);
  // VS Code reveals its permanent-size actions on hover, so the title makes
  // room for them there.
  const vscodeAlwaysActionPaddingClass = hoverButtons === 0 ? undefined : ['group-hover:pe-8', 'group-hover:pe-14', 'group-hover:pe-18', 'group-hover:pe-22'][hoverButtons - 1];
  const alwaysActionPaddingClass = showQuickArchiveAction ? 'pe-13' : 'pe-7';
  // Hover-revealed actions swap in over the row's right end instead of
  // pushing the title: the meta they cover hides and the title's tail
  // fades away under them (`oc-actions-mask`), so nothing moves. The reserve
  // is how far the actions reach in from the row content's right edge: their
  // width less the 6px they sit nearer the row edge (16px buttons, 20px on
  // two-line timeline rows, 2px apart).
  const actionsReserveClass = hoverButtons === 0
    ? undefined
    : isTimelineRow && !isOneLineTimelineRow
      ? ['[--oc-actions-reserve:0.875rem]', '[--oc-actions-reserve:2.25rem]', '[--oc-actions-reserve:3.625rem]', '[--oc-actions-reserve:5rem]'][hoverButtons - 1]
      : ['[--oc-actions-reserve:0.625rem]', '[--oc-actions-reserve:1.75rem]', '[--oc-actions-reserve:2.875rem]', '[--oc-actions-reserve:4rem]'][hoverButtons - 1];
  // An open row menu (dropdown or right-click) keeps the actions shown, so
  // what they cover gives way too, hover or not. A row with no hover actions
  // covers nothing.
  const actionsMaskClass = alwaysShowActions || hoverButtons === 0
    ? undefined
    : isSessionMenuOpen
      ? 'oc-actions-mask'
      : isVSCode
        ? 'group-hover:oc-actions-mask'
        : 'group-hover:oc-actions-mask group-has-[:focus-visible]:oc-actions-mask';
  const coveredMetaFadeClass = hoverButtons === 0 ? '' : isSessionMenuOpen ? 'opacity-0' : hideOnHoverClass;
  // Two-line zone rows are taller, so their hover actions step up one
  // size to match the metadata they replace (the pin marker, the dot, the time).
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
    actionsMaskClass,
    coveredMetaFadeClass,
    actionButtonSizeClass,
    actionIconSizeClass,
    checkIconSizeClass,
  };
};
