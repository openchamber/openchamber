/**
 * The bar at the top of every phone screen and drawer. One height, one inset
 * and one button size, so back, close and the title stay under the same spot of
 * the thumb from screen to screen.
 */
export const MOBILE_HEADER_CLASS = 'flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-2';

export const MOBILE_HEADER_BUTTON_CLASS = 'relative flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground touch-manipulation transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-interactive-hover';

export const MOBILE_HEADER_TITLE_CLASS = 'typography-ui-label font-medium text-foreground';
