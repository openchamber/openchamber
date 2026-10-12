import React from 'react';
import { SIDEBAR_DISCLOSURE_EASING, SIDEBAR_DISCLOSURE_MS } from '@/components/session/sidebar/sessionSidebarDisclosure';

const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * What a sessions-sheet header shows or hides. It opens and closes the way the
 * desktop sidebar's rows and a reasoning block in the chat do: its height eases
 * between zero and the content's own as the content fades. It renders only
 * while open or folding away, and a reversal mid-way starts from the height
 * reached. The first render does not animate.
 */
export function MobileDisclosure({ open, children }: { open: boolean; children: () => React.ReactNode }): React.ReactNode {
  const [mounted, setMounted] = React.useState(open);
  if (open && !mounted) setMounted(true);
  const ref = React.useRef<HTMLDivElement>(null);
  const animationRef = React.useRef<Animation | null>(null);
  const settledOpenRef = React.useRef(open);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (settledOpenRef.current === open || !element) return;
    settledOpenRef.current = open;
    if (prefersReducedMotion()) {
      if (!open) setMounted(false);
      return;
    }
    // Mid-way, start from the height reached; otherwise from shut or full.
    const from = animationRef.current || !open ? element.getBoundingClientRect().height : 0;
    animationRef.current?.cancel();
    const to = open ? element.scrollHeight : 0;
    // Clipped only while it moves, so swipe actions and focus rings show at rest.
    element.style.overflow = 'hidden';
    const animation = element.animate(
      [{ height: `${from}px`, opacity: open ? 0 : 1 }, { height: `${to}px`, opacity: open ? 1 : 0 }],
      // A closing body is held shut until it unmounts a render later;
      // released at once, it would flash back at full height for a frame.
      { duration: SIDEBAR_DISCLOSURE_MS, easing: SIDEBAR_DISCLOSURE_EASING, fill: open ? 'none' : 'forwards' },
    );
    animationRef.current = animation;
    void animation.finished.then(() => {
      if (animationRef.current !== animation) return;
      animationRef.current = null;
      if (open) element.style.overflow = '';
      else setMounted(false);
    }, () => undefined);
  }, [open]);

  React.useEffect(() => () => animationRef.current?.cancel(), []);

  if (!mounted) return null;
  return (
    <div ref={ref} aria-hidden={!open || undefined} inert={!open}>
      {children()}
    </div>
  );
}
