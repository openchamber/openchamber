import React from 'react';
import { createPortal } from 'react-dom';
import { registerZoneHeaderHost, ZONE_HEADER_SLOT_ATTRIBUTE } from './zoneHeaderHosts';

type HeaderEntry = { slot: HTMLDivElement; host: HTMLDivElement };
type RegisterHeader = (entry: HeaderEntry) => () => void;
// external: https://developer.mozilla.org/en-US/docs/Web/API/Element/moveBefore State-preserving moves need an optional declaration with the installed DOM types.
type HostParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
const HeaderContext = React.createContext<RegisterHeader | null>(null);

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

export function CrossfadeZoneHeaders({ suspended = false, layoutKey = '', scrollRef, children }: {
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
    if (suspended || !root) return;
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
      // external: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus Focus restoration can scroll, so header moves preserve the scroller position.
      const scrollTop = restoreFocus ? root.scrollTop : null;
      if (parent.moveBefore && parent.isConnected && entry.host.isConnected) {
        parent.moveBefore(entry.host, null);
      } else {
        parent.append(entry.host);
      }
      if (restoreFocus) focused.focus({ preventScroll: true });
      if (scrollTop !== null && root.scrollTop !== scrollTop) root.scrollTop = scrollTop;
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
          if (entry.slot.parentElement) resize.observe(entry.slot.parentElement);
          observed.add(entry);
        }
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    refreshRef.current = refresh;
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
  }, [suspended, layoutKey, scrollRef]);

  return (
    <HeaderContext.Provider value={register}>
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
    const unregisterHost = registerZoneHeaderHost(slot, host);
    return () => {
      unregister();
      unregisterHost();
      host.remove();
    };
  }, [host, register]);
  return <><div ref={slotRef} {...{ [ZONE_HEADER_SLOT_ATTRIBUTE]: '' }} />{createPortal(<div {...props} />, host)}</>;
}

export function CrossfadeZoneHeader(props: HeaderProps) {
  const register = React.useContext(HeaderContext);
  return register ? <PortalZoneHeader {...props} register={register} /> : <div {...props} />;
}
