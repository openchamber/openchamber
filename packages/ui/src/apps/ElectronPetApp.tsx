import React from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import type { RuntimeAPIs } from '@/lib/api/types';
import { invokeDesktop } from '@/lib/desktop';
import { PetSprite, type PetSpriteHandle } from '@/components/pet/PetSprite';
import { PetBubble } from '@/components/pet/PetBubble';
import {
  PET_ACTION_CHANNEL,
  PET_SPRITE_FRAME_WIDTH,
  PET_STATE_CHANNEL,
  type PetActionMessage,
  type PetAsset,
  type PetDragDirection,
  type PetStateMessage,
} from '@/lib/pet/petContract';

const IDLE_STATE: PetStateMessage = {
  type: 'pet-state',
  state: 'idle',
  thread: null,
  approvals: [],
  count: 0,
};

// Width mirrors the shell's PET_WINDOW_MIN/MAX_WIDTH (main.mjs) — only the width
// is clamped here (it's the resize knob); height is content-fit and clamped by
// the shell. The shell re-clamps regardless; matching keeps the grab from
// visually overshooting.
const MIN_WINDOW = { width: 180, height: 90 };
const MAX_WINDOW = { width: 720, height: 760 };

// Re-arm the hover "jump" at most this often so pointer jitter doesn't keep
// resetting the animation to its first frame.
const JUMP_COOLDOWN_MS = 1200;
// Min horizontal cursor delta (px) during a drag that counts as a direction,
// filtering out jitter so a near-vertical drag doesn't flip running-left/right.
const DRAG_DIRECTION_MIN_DELTA = 3;
// A pointerup that ends a drag/resize synthesizes a trailing `click`. Because the
// window moved (drag) or resized/recentered (resize) under the cursor, that click
// can land on the status bubble and fire its "open chat" handler. Ignore the open
// for a short window after a gesture so only a genuine click (no recent gesture)
// opens the chat.
const GESTURE_CLICK_GRACE_MS = 250;
// Max cursor displacement (px) between pointerdown and pointerup on the sprite
// that still counts as a click (focus the chat) rather than a drag (move the pet).
const TAP_MOVE_TOLERANCE = 5;

const readSlug = (): string => {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('slug')?.trim() ?? '';
};

// Derive the sprite scale from the live (resizable) window WIDTH only. The
// window HEIGHT is content-fit (see the relayout effect below), so scale must
// not depend on height — otherwise the two would feed back into each other
// (taller content → smaller scale → shorter content → …).
const computeScale = (width: number): number => {
  const byWidth = (width * 0.4) / PET_SPRITE_FRAME_WIDTH;
  return Math.max(0.4, Math.min(3, byWidth));
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const pointInElement = (element: Element, x: number, y: number): boolean => {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
};

export function ElectronPetApp({ apis }: { apis: RuntimeAPIs }) {
  const { currentTheme } = useThemeSystem();
  const { t } = useI18n();
  const [asset, setAsset] = React.useState<PetAsset | null>(null);
  const [petState, setPetState] = React.useState<PetStateMessage>(IDLE_STATE);
  // Drag-direction override (running-left/right) while the pet is dragged.
  const [dragDirection, setDragDirection] = React.useState<PetDragDirection | null>(null);
  // Live window width; the sprite scale is derived from it (width-only, see
  // computeScale). Kept in sync with OS-edge resizes and the hover grab.
  const [petWidth, setPetWidth] = React.useState(() =>
    typeof window === 'undefined' ? 300 : window.innerWidth,
  );
  const scale = computeScale(petWidth);
  // Pointer is over the pet (drives the resize-grab visibility). Mirrors the
  // click-through interactive state.
  const [hovered, setHovered] = React.useState(false);
  // True while the user is dragging the resize grab — drives its visibility.
  // (Custom OS cursors are intentionally not used: the overlay is focusable:false
  // so macOS won't honor a CSS cursor on it anyway.)
  const [resizing, setResizing] = React.useState(false);

  const spriteRef = React.useRef<PetSpriteHandle | null>(null);
  // Kept open for the window's lifetime so bubble actions (Allow/Deny, focus)
  // can be relayed to the main renderer, which owns the live sync + actions.
  const actionChannelRef = React.useRef<BroadcastChannel | null>(null);
  const lastJumpRef = React.useRef(0);
  const welcomedRef = React.useRef(false);
  // Whether the shell currently treats the window as interactive (vs click-
  // through). Deduped so we don't spam IPC on every mousemove frame.
  const interactiveRef = React.useRef(false);
  const draggingRef = React.useRef(false);
  const spriteHoverRef = React.useRef(false);
  // Timestamp of the last drag/resize gesture end; gates the trailing synthesized
  // click so a gesture can't open the chat (see GESTURE_CLICK_GRACE_MS).
  const gestureEndedAtRef = React.useRef(0);
  // Latest broadcast state, mirrored into a ref so a sprite tap can focus the
  // active session without making the pointer handlers depend on petState.
  const petStateRef = React.useRef<PetStateMessage>(IDLE_STATE);

  const sendAction = React.useCallback((action: PetActionMessage) => {
    // A drag/resize ends with a synthesized click that can land on the bubble;
    // don't let that open the chat. Other actions (Allow/Deny) are unaffected.
    if (action.type === 'focus-session' && Date.now() - gestureEndedAtRef.current < GESTURE_CLICK_GRACE_MS) {
      return;
    }
    actionChannelRef.current?.postMessage(action);
  }, []);

  // A tap on the character focuses the chat — navigating to the session the bubble
  // is surfacing when there is one, otherwise just raising the main window.
  const focusActiveSession = React.useCallback(() => {
    const current = petStateRef.current;
    const sessionId = current.thread?.sessionId || current.approvals[0]?.sessionId || '';
    sendAction({ type: 'focus-session', sessionId });
  }, [sendAction]);

  // Flip the overlay between interactive (clicks/drag land on the pet) and
  // click-through (the transparent area never blocks the desktop). The renderer
  // owns the hit-test; the shell just applies setIgnoreMouseEvents.
  const setPetInteractive = React.useCallback((next: boolean) => {
    if (interactiveRef.current === next) return;
    interactiveRef.current = next;
    setHovered(next);
    void invokeDesktop('desktop_pet_set_interactive', { interactive: next }).catch(() => {});
  }, []);

  const playJump = React.useCallback(() => {
    const now = Date.now();
    if (now - lastJumpRef.current < JUMP_COOLDOWN_MS) return;
    lastJumpRef.current = now;
    spriteRef.current?.play('jumping');
  }, []);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  // Load the selected pet's spritesheet (inlined as a data URL) from the shell.
  // `null` means "no pet selected / not found" — render nothing, stay transparent.
  React.useEffect(() => {
    let active = true;
    const slug = readSlug();
    if (!slug) {
      setAsset(null);
      return;
    }
    void invokeDesktop<PetAsset | null>('desktop_pet_get', { slug })
      .then((result) => {
        if (active) setAsset(result ?? null);
      })
      .catch(() => {
        if (active) setAsset(null);
      });
    return () => {
      active = false;
    };
  }, []);

  // The main renderer is the source of truth for live state; subscribe to its
  // throttled broadcast and ask it to send the current state now (rather than
  // waiting for the next tick) so the pet reflects reality the moment it opens.
  React.useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const stateChannel = new BroadcastChannel(PET_STATE_CHANNEL);
    stateChannel.onmessage = (event) => {
      const data = event.data as PetStateMessage | undefined;
      if (data && data.type === 'pet-state') {
        petStateRef.current = data;
        setPetState(data);
      }
    };

    const actionChannel = new BroadcastChannel(PET_ACTION_CHANNEL);
    actionChannelRef.current = actionChannel;
    const requestState: PetActionMessage = { type: 'request-state' };
    actionChannel.postMessage(requestState);

    return () => {
      stateChannel.close();
      actionChannel.close();
      actionChannelRef.current = null;
    };
  }, []);

  // Keep the derived sprite scale in lockstep with the window width (covers OS
  // edge-resizes and the shell applying the hover-grab / content-fit size).
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setPetWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Pointer interactivity (Codex's avatar-overlay model). The shell keeps the
  // window click-through with `forward: true`, so mousemove still reaches us; we
  // hit-test the cursor against the pet's elements and toggle interactivity on
  // only while it's actually over the sprite/bubble/grab. This is also what makes
  // the hover "jump" fire — an app-region drag region would swallow these events.
  const resizeSessionRef = React.useRef<
    { startX: number; startY: number; startW: number; targetW: number; raf: number } | null
  >(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = 0;
    let lastPoint: { x: number; y: number } | null = null;

    const evaluate = () => {
      raf = 0;
      // Never drop interactivity mid-gesture, even if a fast drag outruns the
      // cursor or the grab pulls the window out from under the pointer.
      if (draggingRef.current || resizeSessionRef.current) {
        setPetInteractive(true);
        return;
      }
      const point = lastPoint;
      if (!point) return;
      let overInteractive = false;
      let overSprite = false;
      for (const node of Array.from(document.querySelectorAll('[data-pet-hit]'))) {
        if (!pointInElement(node, point.x, point.y)) continue;
        overInteractive = true;
        if ((node as HTMLElement).dataset.petSprite !== undefined) overSprite = true;
      }
      setPetInteractive(overInteractive);
      if (overSprite && !spriteHoverRef.current) playJump();
      spriteHoverRef.current = overSprite;
    };

    const onMove = (event: MouseEvent) => {
      lastPoint = { x: event.clientX, y: event.clientY };
      if (!raf) raf = window.requestAnimationFrame(evaluate);
    };
    const onLeave = () => {
      if (draggingRef.current || resizeSessionRef.current) return;
      lastPoint = null;
      spriteHoverRef.current = false;
      setPetInteractive(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [setPetInteractive, playJump]);

  // One-time wake greeting: only when nothing else needs attention, so opening
  // the pet mid-activity surfaces the live state burst instead of the wave.
  React.useEffect(() => {
    if (!asset || welcomedRef.current) return;
    welcomedRef.current = true;
    if (petState.state === 'idle') spriteRef.current?.play('waving');
  }, [asset, petState.state]);

  // Content-fit height: size the overlay window to exactly the bubble + sprite
  // so there is no dead transparent space above the pet. Previously the window
  // reserved ~half its height for the bubble, so its (invisible) top edge hit
  // the screen top long before the character could be dragged there. Width stays
  // user-controlled (drives scale); the shell bottom-anchors the height change
  // so the pet stays put while the bubble grows/shrinks above it.
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const lastRelayHeightRef = React.useRef(0);

  const relayoutHeight = React.useCallback(() => {
    // The drag owns the window position; resizing it mid-drag fights the
    // shell's setPosition. endDrag re-fits once the drag settles.
    if (draggingRef.current) return;
    const el = contentRef.current;
    if (!el) return;
    const height = Math.ceil(el.getBoundingClientRect().height);
    if (height <= 0) return;
    // Ignore sub-2px churn so a flickering measurement can't walk the window up.
    if (Math.abs(height - lastRelayHeightRef.current) < 2) return;
    lastRelayHeightRef.current = height;
    void invokeDesktop('desktop_resize_pet_window', { height, anchor: 'bottom' }).catch(() => {});
  }, []);

  React.useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        relayoutHeight();
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
    // `asset` gates rendering of the measured wrapper, so re-run once it mounts.
  }, [relayoutHeight, asset]);

  // Custom drag: the window is frameless + non-focusable, so we move it via the
  // shell from the live cursor (desktop_pet_drag_*) and derive direction locally.
  const dragRafRef = React.useRef(0);
  const lastDragXRef = React.useRef<number | null>(null);
  // Pointer-down origin + whether the pointer moved past TAP_MOVE_TOLERANCE, so
  // endDrag can tell a click (focus the chat) from a drag (move the pet).
  const dragStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const dragMovedRef = React.useRef(false);

  const onSpritePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    draggingRef.current = true;
    dragStartRef.current = { x: event.screenX, y: event.screenY };
    dragMovedRef.current = false;
    lastDragXRef.current = event.screenX;
    setPetInteractive(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    void invokeDesktop('desktop_pet_drag_start').catch(() => {});
  }, [setPetInteractive]);

  const onSpritePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const start = dragStartRef.current;
    if (
      start &&
      (Math.abs(event.screenX - start.x) > TAP_MOVE_TOLERANCE ||
        Math.abs(event.screenY - start.y) > TAP_MOVE_TOLERANCE)
    ) {
      dragMovedRef.current = true;
    }
    const previousX = lastDragXRef.current;
    if (previousX !== null) {
      const dx = event.screenX - previousX;
      if (Math.abs(dx) >= DRAG_DIRECTION_MIN_DELTA) setDragDirection(dx < 0 ? 'left' : 'right');
    }
    lastDragXRef.current = event.screenX;
    if (dragRafRef.current) return;
    dragRafRef.current = window.requestAnimationFrame(() => {
      dragRafRef.current = 0;
      void invokeDesktop('desktop_pet_drag_move').catch(() => {});
    });
  }, []);

  const endDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const moved = dragMovedRef.current;
    dragMovedRef.current = false;
    dragStartRef.current = null;
    // A real drag ends with a synthesized click that can land on the bubble;
    // suppress the open so moving the pet never focuses the chat.
    if (moved) gestureEndedAtRef.current = Date.now();
    if (dragRafRef.current) {
      window.cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    lastDragXRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    void invokeDesktop('desktop_pet_drag_end').catch(() => {});
    // A tap (no meaningful movement) is a click on the character → focus the chat.
    if (!moved) focusActiveSession();
    // Let the last running frame breathe, then fall back to the state animation
    // and re-fit the window (relayout is suppressed while dragging, so a bubble
    // that changed height mid-drag is reconciled here).
    window.setTimeout(() => {
      if (!draggingRef.current) {
        setDragDirection(null);
        relayoutHeight();
      }
    }, 140);
  }, [relayoutHeight, focusActiveSession]);

  // Pointer-driven resize from the grab next to the sprite. The grab controls
  // the WIDTH (which drives the sprite scale); the height auto-fits the content
  // (relayoutHeight). Screen coords stay stable while the window resizes. The
  // shell owns and re-clamps the bounds. rAF-coalesced to one IPC per frame.
  const onResizePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Stop the sprite's drag handler from also firing for this gesture.
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    resizeSessionRef.current = {
      startX: event.screenX,
      startY: event.screenY,
      startW: window.innerWidth,
      targetW: window.innerWidth,
      raf: 0,
    };
    setResizing(true);
    setPetInteractive(true);
  }, [setPetInteractive]);

  const onResizePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const session = resizeSessionRef.current;
    if (!session) return;
    // Diagonal grab: grow on whichever axis the user pulls furthest, so dragging
    // down OR right enlarges the pet. Width is the single size knob now.
    const delta = Math.max(event.screenX - session.startX, event.screenY - session.startY);
    session.targetW = clamp(Math.round(session.startW + delta), MIN_WINDOW.width, MAX_WINDOW.width);
    setPetWidth(session.targetW); // optimistic: scale the sprite without waiting for the roundtrip
    if (session.raf) return;
    session.raf = window.requestAnimationFrame(() => {
      session.raf = 0;
      const current = resizeSessionRef.current;
      if (!current) return;
      void invokeDesktop('desktop_resize_pet_window', { width: current.targetW }).catch(() => {});
    });
  }, []);

  const endResize = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const session = resizeSessionRef.current;
    if (session?.raf) window.cancelAnimationFrame(session.raf);
    if (session) gestureEndedAtRef.current = Date.now();
    resizeSessionRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    setResizing(false);
  }, []);

  if (!asset) return null;

  return (
    <ErrorBoundary>
      {/* No app-region drag: that would swallow hover/click events and block the
          desktop. The whole window is click-through (shell side); only the
          [data-pet-hit] children below capture the pointer. The sprite sits at
          the bottom so the status bubble grows upward above it. The window is
          content-fit (relayoutHeight), so this fills it with no dead space. */}
      <div className="flex h-full w-full flex-col items-center justify-end">
        {/* Measured wrapper: the shell sizes the window to exactly this box, so
            there is no transparent dead space above the pet. */}
        <div ref={contentRef} className="flex flex-col items-center gap-2 p-2">
          <PetBubble message={petState} onAction={sendAction} />

          {/* The sprite is the drag handle (drag the visible character, like
              Codex). The resize grab sits at its corner, close to the character. */}
          <div
            data-pet-hit
            data-pet-sprite
            className="relative"
            style={{ touchAction: 'none' }}
            onPointerDown={onSpritePointerDown}
            onPointerMove={onSpritePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <PetSprite
              ref={spriteRef}
              spritesheetDataUrl={asset.spritesheetDataUrl}
              state={petState.state}
              dragDirection={dragDirection}
              scale={scale}
            />

            {/* Resize grab at the sprite's bottom-right corner — beside the
                character, not in a far window corner. Revealed on hover. */}
            <div
              data-pet-hit
              role="separator"
              aria-label={t('pet.resize.aria')}
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="absolute -bottom-1 -right-1 flex h-4 w-4 cursor-nwse-resize items-center justify-center rounded-full border shadow-sm transition-opacity"
              style={
                {
                  opacity: hovered || resizing ? 1 : 0,
                  backgroundColor: currentTheme.colors.surface.elevated,
                  borderColor: currentTheme.colors.interactive.border,
                  color: currentTheme.colors.surface.mutedForeground,
                } as React.CSSProperties
              }
            >
              {/* A diagonal grip reads as a resize handle. */}
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
                <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
