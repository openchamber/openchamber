type Track = {
  column: HTMLElement;
  content: Element | null;
  track: HTMLDivElement;
  spacer: HTMLDivElement;
  detach: () => void;
};

const findCodeColumns = (pre: Element | null): HTMLElement[] => pre
  ? Array.from(pre.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute('data-code'))
  : [];

/**
 * Mirrors the horizontal scroll of each code column Pierre renders inside
 * `container` (two in a split diff, one in a unified one) into a track inside
 * `bar`, which the caller keeps sticky at the bottom of the scrolling panel.
 *
 * Sizes are read only in ResizeObserver callbacks, after the browser's own
 * layout, so vertical scrolling and row virtualization cost nothing here.
 * Structure is followed with child-list observers on the host, its shadow
 * root, the `pre` and each column; the rows Pierre swaps while scrolling sit
 * one level deeper and are not observed.
 */
export const bindStickyScrollbar = (container: HTMLElement, bar: HTMLElement): (() => void) => {
  const tracks = new Map<HTMLElement, Track>();

  const measure = () => {
    // All reads first: a write between them would force a second layout.
    const origin = container.getBoundingClientRect().left;
    const sizes = Array.from(tracks.values(), (entry) => ({
      entry,
      left: entry.column.getBoundingClientRect().left - origin,
      clientWidth: entry.column.clientWidth,
      scrollWidth: entry.column.scrollWidth,
      scrollLeft: entry.column.scrollLeft,
    }));
    bar.hidden = !sizes.some((size) => size.scrollWidth - size.clientWidth > 1);
    for (const { entry, left, clientWidth, scrollWidth, scrollLeft } of sizes) {
      const overflow = scrollWidth - clientWidth > 1;
      entry.track.hidden = !overflow;
      if (!overflow) continue;
      entry.track.style.left = `${left}px`;
      entry.track.style.width = `${clientWidth}px`;
      entry.spacer.style.width = `${scrollWidth}px`;
      entry.track.scrollLeft = scrollLeft;
    }
  };

  const resizeObserver = new ResizeObserver(measure);
  const mutationObserver = new MutationObserver(() => sync());

  const attach = (column: HTMLElement): Track => {
    const track = document.createElement('div');
    track.className = 'absolute inset-y-0 overflow-x-auto overflow-y-hidden overscroll-x-none';
    track.tabIndex = -1;
    track.hidden = true;
    const spacer = document.createElement('div');
    spacer.className = 'h-px';
    track.appendChild(spacer);
    bar.appendChild(track);

    // Each side follows the other; the guard stops the echo of our own write.
    const onColumnScroll = () => {
      if (Math.abs(track.scrollLeft - column.scrollLeft) >= 1) track.scrollLeft = column.scrollLeft;
    };
    const onTrackScroll = () => {
      if (Math.abs(column.scrollLeft - track.scrollLeft) >= 1) column.scrollLeft = track.scrollLeft;
    };
    column.addEventListener('scroll', onColumnScroll, { passive: true });
    track.addEventListener('scroll', onTrackScroll, { passive: true });
    resizeObserver.observe(column);

    return {
      column,
      content: null,
      track,
      spacer,
      detach: () => {
        column.removeEventListener('scroll', onColumnScroll);
        track.removeEventListener('scroll', onTrackScroll);
        resizeObserver.unobserve(column);
        track.remove();
      },
    };
  };

  const sync = () => {
    const root = container.querySelector('diffs-container')?.shadowRoot ?? null;
    const pre = root?.querySelector('pre') ?? null;
    const columns = findCodeColumns(pre);

    for (const [column, entry] of tracks) {
      if (columns.includes(column)) continue;
      entry.detach();
      if (entry.content) resizeObserver.unobserve(entry.content);
      tracks.delete(column);
    }
    for (const column of columns) {
      const entry = tracks.get(column) ?? attach(column);
      tracks.set(column, entry);
      // The content box grows with the longest rendered line, which the
      // column's own box does not show.
      const content = Array.from(column.children).find((child) => child.hasAttribute('data-content')) ?? null;
      if (content !== entry.content) {
        if (entry.content) resizeObserver.unobserve(entry.content);
        if (content) resizeObserver.observe(content);
        entry.content = content;
      }
    }

    mutationObserver.disconnect();
    mutationObserver.observe(container, { childList: true });
    if (root) mutationObserver.observe(root, { childList: true });
    if (pre) mutationObserver.observe(pre, { childList: true });
    for (const column of columns) mutationObserver.observe(column, { childList: true });
    if (tracks.size === 0) bar.hidden = true;
  };

  sync();
  resizeObserver.observe(container);

  return () => {
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    for (const entry of tracks.values()) entry.detach();
    tracks.clear();
    bar.hidden = true;
  };
};
