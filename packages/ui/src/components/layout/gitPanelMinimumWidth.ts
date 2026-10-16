/** Measures the Git panel with its picker labels fully collapsed. */
export function measureGitPanelMinimumWidth(toolbar: HTMLElement): number {
  const parent = toolbar.parentElement?.parentElement;
  const card = toolbar.closest<HTMLElement>('[data-zone-card]');
  if (!parent || !card) return 0;

  const cardStyle = getComputedStyle(card);
  // The aside and card animate separately; measure inside the same box.
  const chromeWidth = card.getBoundingClientRect().width - toolbar.getBoundingClientRect().width
    + Number.parseFloat(cardStyle.marginInlineStart) + Number.parseFloat(cardStyle.marginInlineEnd);

  const probe = toolbar.cloneNode(true);
  if (!(probe instanceof HTMLElement)) return 0;
  probe.inert = true;
  probe.setAttribute('aria-hidden', 'true');
  Object.assign(probe.style, {
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    width: '0px',
    flex: 'none',
    transition: 'none',
  });
  // Outside the slot observed by ContextPanel, so the probe cannot retrigger it.
  parent.append(probe);
  try {
    const row = probe.firstElementChild;
    const endPadding = row instanceof HTMLElement
      ? Number.parseFloat(getComputedStyle(row).paddingInlineEnd) || 0
      : 0;
    return Math.ceil(chromeWidth + probe.scrollWidth + endPadding);
  } finally {
    probe.remove();
  }
}
