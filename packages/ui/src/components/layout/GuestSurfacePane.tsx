import React from 'react';

import type { SurfaceInputEvent, SurfaceModifiers } from '@openchamber/sdk';

import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { isGuestActive } from '@/lib/guests/capabilities';
import { useGuestsStore } from '@/lib/guests/store';
import { clearSurfaceViewerId, setSurfaceViewerId } from '@/lib/guests/surface-viewers';
import { SurfaceClient, type SurfaceConnectionState, type SurfaceControlState, type SurfaceFrame } from '@/lib/guests/surface-client';
import { pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { cn } from '@/lib/utils';

/**
 * The rail panel of an extension whose service shows a shared surface: a
 * live picture of what the agent is working in, which the user can take
 * over by clicking or typing and hand back with one button.
 *
 * The picture is a canvas the host draws; the extension never runs code in
 * this panel. Pointer and keyboard events are translated to frame pixels
 * and sent as a batch per animation frame. While the surface has focus the
 * host's own shortcuts stand down (`data-terminal-owner`, the same gate the
 * terminal uses), so a Ctrl+P typed into a remote page stays in that page.
 * Paste sends text rather than the key chord; copy sends the chord and then
 * asks the extension for what was copied, so the user's clipboard follows.
 */

type Props = { mode: PluginContextPanelMode };

const RESIZE_DEBOUNCE_MS = 250;

const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SurfaceModifiers => ({
  alt: event.altKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
  shift: event.shiftKey,
});

const isCopyChord = (event: React.KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'c';
const isPasteChord = (event: React.KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'v';

export const GuestSurfacePane: React.FC<Props> = ({ mode }) => {
  const { t } = useI18n();
  const guestId = pluginIdFromMode(mode);
  const guest = useGuestsStore((state) => state.guests.find((entry) => entry.id === guestId) ?? null);
  const active = guest !== null && isGuestActive(guest) && guest.service?.surface === true;

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const clientRef = React.useRef<SurfaceClient | null>(null);
  const frameSizeRef = React.useRef<{ width: number; height: number } | null>(null);
  const batchRef = React.useRef<SurfaceInputEvent[]>([]);
  const flushRef = React.useRef<number | null>(null);
  const clipboardRequestsRef = React.useRef(0);
  /** A copy chord in the current batch: ask for the clipboard right after it. */
  const clipboardAfterFlushRef = React.useRef(false);
  const controlRef = React.useRef<SurfaceControlState>({ controller: 'none', mine: false });

  const [connection, setConnection] = React.useState<SurfaceConnectionState>({ status: 'connecting' });
  const [control, setControlState] = React.useState<SurfaceControlState>({ controller: 'none', mine: false });
  const setControl = React.useCallback((next: SurfaceControlState) => {
    controlRef.current = next;
    setControlState(next);
  }, []);
  const [title, setTitle] = React.useState<string>('');
  const [agentActive, setAgentActive] = React.useState(false);
  const [hasFrame, setHasFrame] = React.useState(false);
  const [focused, setFocused] = React.useState(false);

  const drawFrame = React.useCallback(async (frame: SurfaceFrame) => {
    const canvas = canvasRef.current;
    const client = clientRef.current;
    if (!canvas || !client) return;
    try {
      const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: frame.mime }));
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      const context = canvas.getContext('2d');
      context?.drawImage(bitmap, 0, 0, frame.width, frame.height);
      bitmap.close();
      frameSizeRef.current = { width: frame.width, height: frame.height };
      setHasFrame(true);
      setTitle(frame.title ?? '');
      setAgentActive(frame.agentActive);
    } catch {
      // An undecodable frame is skipped; the next one replaces it.
    } finally {
      // Acknowledged after drawing, whatever happened: an unacknowledged
      // frame would stop every later one.
      client.ack(frame.seq);
    }
  }, []);

  React.useEffect(() => {
    if (!active) return undefined;
    let viewerId: string | null = null;
    const client = new SurfaceClient(guestId, {
      onViewer: (id) => {
        if (viewerId) clearSurfaceViewerId(guestId, viewerId);
        viewerId = id;
        setSurfaceViewerId(guestId, id);
      },
      onFrame: (frame) => { void drawFrame(frame); },
      onControl: setControl,
      onConnection: setConnection,
      onClipboard: (_id, text) => { void copyTextToClipboard(text); },
    });
    clientRef.current = client;
    client.start();
    return () => {
      if (viewerId) clearSurfaceViewerId(guestId, viewerId);
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
      if (flushRef.current !== null) cancelAnimationFrame(flushRef.current);
      flushRef.current = null;
      batchRef.current = [];
      frameSizeRef.current = null;
      setHasFrame(false);
    };
  }, [active, drawFrame, guestId, setControl]);

  // Tell the extension how much room the panel has, so a browser or a
  // simulator can lay itself out at that size instead of being scaled.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const scale = window.devicePixelRatio || 1;
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);
        if (w > 0 && h > 0) clientRef.current?.resize(w, h);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  const queue = React.useCallback((event: SurfaceInputEvent) => {
    batchRef.current.push(event);
    if (flushRef.current !== null) return;
    flushRef.current = requestAnimationFrame(() => {
      flushRef.current = null;
      const events = batchRef.current;
      batchRef.current = [];
      clientRef.current?.sendInput(events);
      // Sent on the same socket right after the batch; the host handles
      // them in order, so the extension has done the copy by the time it
      // is asked what was copied.
      if (clipboardAfterFlushRef.current) {
        clipboardAfterFlushRef.current = false;
        clipboardRequestsRef.current += 1;
        clientRef.current?.requestClipboard(`copy-${clipboardRequestsRef.current}`);
      }
    });
  }, []);

  /** Pointer position in frame pixels, or null when outside the picture. */
  const framePoint = React.useCallback((event: React.PointerEvent | React.WheelEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const size = frameSizeRef.current;
    if (!canvas || !size) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * size.width;
    const y = ((event.clientY - rect.top) / rect.height) * size.height;
    return { x: Math.round(x), y: Math.round(y) };
  }, []);

  const onPointer = (action: 'down' | 'up' | 'move') => (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    // Hovering is looking, not acting: moves without a button go out only
    // once the user holds control, so a glance never takes it from the agent.
    if (action === 'move' && event.buttons === 0 && !(controlRef.current.controller === 'user' && controlRef.current.mine)) return;
    const point = framePoint(event);
    if (!point) return;
    if (action === 'down') {
      containerRef.current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (action === 'up' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    queue({
      type: 'pointer',
      action,
      x: point.x,
      y: point.y,
      button: action === 'move' ? -1 : event.button,
      buttons: event.buttons,
      modifiers: modifiersOf(event),
    });
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    const point = framePoint(event);
    if (!point) return;
    event.preventDefault();
    queue({ type: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) });
  };

  const onKey = (action: 'down' | 'up') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasFrame) return;
    if (isPasteChord(event)) {
      // The paste event carries the text; the chord itself stays here.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action === 'down' && isCopyChord(event)) clipboardAfterFlushRef.current = true;
    queue({ type: 'key', action, key: event.key, code: event.code, modifiers: modifiersOf(event) });
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!hasFrame) return;
    const text = event.clipboardData.getData('text/plain');
    event.preventDefault();
    if (text) queue({ type: 'text', text });
  };

  const release = () => {
    clientRef.current?.release();
  };

  if (!guest) return null;
  if (!active) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        {t('contextPanel.surface.unavailable')}
      </div>
    );
  }

  const statusKey = (() => {
    if (connection.status === 'connecting') return 'contextPanel.surface.status.connecting';
    if (connection.status === 'reconnecting') return 'contextPanel.surface.status.reconnecting';
    if (connection.status === 'ended') return `contextPanel.surface.ended.${connection.reason}` as const;
    if (control.controller === 'user') return control.mine ? 'contextPanel.surface.status.youControl' : 'contextPanel.surface.status.otherControls';
    if (control.controller === 'agent' || agentActive) return 'contextPanel.surface.status.agentWorking';
    return focused ? 'contextPanel.surface.status.readyFocused' : 'contextPanel.surface.status.ready';
  })();

  return (
    <div className="flex h-full flex-col bg-[var(--surface-background)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="typography-meta min-w-0 flex-1 truncate text-foreground" title={title || guest.name}>
          {title || guest.name}
        </span>
        <span
          className={cn(
            'typography-meta shrink-0 truncate',
            control.controller === 'user' && control.mine ? 'text-foreground' : 'text-muted-foreground',
          )}
          aria-live="polite"
        >
          {t(statusKey)}
        </span>
        {control.controller === 'user' && control.mine ? (
          <Button size="xs" variant="outline" onClick={release}>
            {t('contextPanel.surface.handBack')}
          </Button>
        ) : null}
        {connection.status === 'ended' ? (
          <Button size="xs" variant="outline" onClick={() => clientRef.current?.retry()}>
            {t('contextPanel.surface.retry')}
          </Button>
        ) : null}
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label={t('contextPanel.surface.canvasAria', { name: guest.name })}
        data-terminal-owner={`surface:${guestId}`}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden outline-none',
          focused ? 'ring-1 ring-inset ring-[var(--interactive-selection-border)]' : '',
        )}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKey('down')}
        onKeyUp={onKey('up')}
        onPaste={onPaste}
      >
        <canvas
          ref={canvasRef}
          className={cn('max-h-full max-w-full', hasFrame ? 'block' : 'hidden', control.controller === 'user' && !control.mine ? 'cursor-not-allowed' : 'cursor-default')}
          onPointerDown={onPointer('down')}
          onPointerMove={onPointer('move')}
          onPointerUp={onPointer('up')}
          onWheel={onWheel}
          onContextMenu={(event) => event.preventDefault()}
        />
        {!hasFrame || connection.status !== 'open' ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t(connection.status === 'ended' ? `contextPanel.surface.ended.${connection.reason}` : connection.status === 'reconnecting' ? 'contextPanel.surface.status.reconnecting' : 'contextPanel.surface.status.connecting')}
          </div>
        ) : null}
      </div>
    </div>
  );
};
