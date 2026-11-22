const ZONE_FIT_CHAT_MIN_WIDTH = 320;

type ZoneFitInput = {
  rowWidth: number;
  leftWidth: number;
  rightWidth: number;
  sidebarWidth: number | null;
  opening: 'left' | 'right';
};

type ZoneFitPlan = {
  collapseSidebar: boolean;
  displace: 'left' | 'right' | null;
};

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
