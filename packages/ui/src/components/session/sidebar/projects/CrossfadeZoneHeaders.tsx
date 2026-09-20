import React from 'react';
import { createPortal } from 'react-dom';

type HeaderEntry = { slot: HTMLDivElement; host: HTMLDivElement };
type RegisterHeader = (entry: HeaderEntry) => () => void;
// State-preserving DOM moves are newer than our TypeScript DOM declarations.
type HostParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
const HeaderContext = React.createContext<RegisterHeader | null>(null);

// Layout offsets include virtual positioning but exclude transient sortable transforms.
function getLayoutTop(element: HTMLElement): number {
  let top = 0;
  let current: HTMLElement | null = element;
  while (current) {
    top += current.offsetTop;
    const parent: Element | null = current.offsetParent;
    current = parent instanceof HTMLElement ? parent : null;
  }
  const virtualRow = element.closest<HTMLElement>('[data-sidebar-virtual-start]');
  const virtualStart = Number(virtualRow?.dataset.sidebarVirtualStart ?? '0');
  return top + (Number.isFinite(virtualStart) ? virtualStart : 0);
}

/** Keep the live controls mounted in one portal while moving its host between
 * the section and the viewport. Only the outgoing animation is a visual copy. */
export function CrossfadeZoneHeaders({ enabled, suspended = false, layoutKey = '', scrollRef, children }: {
  enabled: boolean;
  suspended?: boolean;
  layoutKey?: string;
  scrollRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const entriesRef = React.useRef(new Set<HeaderEntry>());
  const refreshRef = React.useRef<(() => void) | null>(null);
  const register = React.useCallback<RegisterHeader>((entry) => {
    entriesRef.current.add(entry);
    refreshRef.current?.();
    return () => {
      entriesRef.current.delete(entry);
      refreshRef.current?.();
    };
  }, []);

  React.useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!enabled || suspended || !root) return;
    // Keep the viewport layer inside the native scroller so wheel and touch
    // gestures over a pinned header still scroll the list normally.
    const layer = document.createElement('div');
    layer.dataset.sidebarCrossfadeLayer = 'true';
    layer.className = 'pointer-events-none sticky top-0 z-30 h-0';
    layer.style.marginBlock = '0px';
    root.prepend(layer);

    let active: HeaderEntry | null = null;
    let outgoing: HTMLElement | null = null;
    let animation: Animation | null = null;
    let frame = 0;
    const observed = new Set<HeaderEntry>();
    let boundaries: { entry: HeaderEntry; top: number }[] = [];
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const moveHost = (entry: HeaderEntry, parent: HostParent) => {
      const focused = document.activeElement;
      const restoreFocus = focused instanceof HTMLElement && entry.host.contains(focused);
      if (parent.moveBefore && parent.isConnected && entry.host.isConnected) {
        parent.moveBefore(entry.host, null);
      } else {
        parent.append(entry.host);
      }
      if (restoreFocus) focused.focus({ preventScroll: true });
    };
    const clearAnimation = () => {
      animation?.cancel();
      animation = null;
      outgoing?.remove();
      outgoing = null;
    };
    const sync = () => {
      let next: HeaderEntry | null = null;
      let nearestTop = -Infinity;
      for (const { entry, top } of boundaries) {
        if (top <= root.scrollTop && top >= nearestTop) {
          nearestTop = top;
          next = entry;
        }
      }
      if (active === next) return;

      clearAnimation();
      if (active && next && !reducedMotion.matches) {
        const snapshot = active.host.cloneNode(true);
        if (snapshot instanceof HTMLElement) {
          snapshot.inert = true;
          snapshot.setAttribute('aria-hidden', 'true');
          snapshot.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
          snapshot.className = 'pointer-events-none absolute inset-x-0 top-0 z-30';
          outgoing = snapshot;
        }
      }
      if (active) {
        moveHost(active, active.slot);
        active.slot.style.removeProperty('height');
      }
      active = next;
      layer.hidden = !next;
      if (!next) return;

      next.slot.style.height = `${next.host.getBoundingClientRect().height}px`;
      moveHost(next, layer);
      if (outgoing) {
        layer.append(outgoing);
        animation = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 150,
          easing: 'ease-out',
        });
        // The incoming live header sits under the fading opaque snapshot, so
        // rows never shine through and the controls stay usable throughout.
        animation.onfinish = clearAnimation;
      }
    };
    const measure = () => {
      if (active) active.slot.style.height = `${active.host.getBoundingClientRect().height}px`;
      const origin = getLayoutTop(root) + root.clientTop;
      boundaries = Array.from(entriesRef.current, (entry) => ({
        entry,
        top: getLayoutTop(entry.slot) - origin,
      }));
      sync();
    };
    const resize = new ResizeObserver(measure);
    const positionObserver = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    resize.observe(root);
    const refresh = () => {
      positionObserver.disconnect();
      for (const entry of observed) {
        if (!entriesRef.current.has(entry)) {
          resize.unobserve(entry.host);
          if (entry.slot.parentElement) resize.unobserve(entry.slot.parentElement);
          observed.delete(entry);
        }
      }
      for (const entry of entriesRef.current) {
        const virtualRow = entry.slot.closest<HTMLElement>('[data-sidebar-virtual-start]');
        if (virtualRow) {
          positionObserver.observe(virtualRow, {
            attributes: true,
            attributeFilter: ['data-sidebar-virtual-start'],
          });
        }
        if (!observed.has(entry)) {
          resize.observe(entry.host);
          // Section size changes move later boundaries without resizing the
          // viewport (collapse, Show more, filtering, or arriving sessions).
          if (entry.slot.parentElement) resize.observe(entry.slot.parentElement);
          observed.add(entry);
        }
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    refreshRef.current = refresh;
    // Scroll reads only the few zone headers' cached offsets, never row
    // geometry, and writes only on a handoff.
    root.addEventListener('scroll', sync, { passive: true });
    refresh();
    measure();
    return () => {
      refreshRef.current = null;
      cancelAnimationFrame(frame);
      root.removeEventListener('scroll', sync);
      resize.disconnect();
      positionObserver.disconnect();
      clearAnimation();
      layer.hidden = true;
      if (active) {
        moveHost(active, active.slot);
        active.slot.style.removeProperty('height');
      }
      layer.remove();
    };
  }, [enabled, suspended, layoutKey, scrollRef]);

  return (
    <HeaderContext.Provider value={enabled ? register : null}>
      {children}
    </HeaderContext.Provider>
  );
}

type HeaderProps = React.ComponentPropsWithRef<'div'>;

function PortalZoneHeader({ register, ...props }: HeaderProps & { register: RegisterHeader }) {
  const slotRef = React.useRef<HTMLDivElement>(null);
  const [host] = React.useState(() => {
    const element = document.createElement('div');
    element.className = 'pointer-events-auto flow-root';
    return element;
  });
  React.useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    slot.append(host);
    const unregister = register({ slot, host });
    return () => {
      unregister();
      host.remove();
    };
  }, [host, register]);
  return <><div ref={slotRef} />{createPortal(<div {...props} />, host)}</>;
}

export function CrossfadeZoneHeader(props: HeaderProps) {
  const register = React.useContext(HeaderContext);
  return register ? <PortalZoneHeader {...props} register={register} /> : <div {...props} />;
}
