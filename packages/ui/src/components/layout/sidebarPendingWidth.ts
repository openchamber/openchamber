export const sidebarPendingWidth = (): number => {
  const sidebar = document.querySelector<HTMLElement>('[data-left-sidebar]');
  if (!sidebar) return 0;
  return Math.round(sidebar.getBoundingClientRect().width - (Number.parseFloat(sidebar.style.width) || 0));
};
