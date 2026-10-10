/** The chat column never gets narrower than this beside the side zones. */
const ZONE_FIT_CHAT_MIN_WIDTH = 400;

type ZoneFitInput = {
  /** The workspace row's width now: left zone, chat and right zone. */
  rowWidth: number;
  /** Widths the side zones take once the one being opened is on screen. */
  leftWidth: number;
  rightWidth: number;
  /** The session sidebar beside the row, when it is open. */
  sidebarWidth: number | null;
  /** The zone that just opened; the other side is the one that may give way. */
  opening: 'left' | 'right';
};

type ZoneFitPlan = {
  collapseSidebar: boolean;
  /** The opposite side zone, closed to make room. */
  displace: 'left' | 'right' | null;
};

/**
 * Room for a side zone that just opened: the chat keeps its minimum width.
 * The session sidebar folds first (navigation, one click back); only when
 * that is not enough does the zone on the other side close.
 */
export const planZoneFit = ({ rowWidth, leftWidth, rightWidth, sidebarWidth, opening }: ZoneFitInput): ZoneFitPlan => {
  let chatWidth = rowWidth - leftWidth - rightWidth;
  if (chatWidth >= ZONE_FIT_CHAT_MIN_WIDTH) return { collapseSidebar: false, displace: null };

  const collapseSidebar = sidebarWidth !== null;
  if (collapseSidebar) chatWidth += sidebarWidth;
  if (chatWidth >= ZONE_FIT_CHAT_MIN_WIDTH) return { collapseSidebar, displace: null };

  const other = opening === 'left' ? 'right' : 'left';
  const otherWidth = other === 'left' ? leftWidth : rightWidth;
  return { collapseSidebar, displace: otherWidth > 0 ? other : null };
};
