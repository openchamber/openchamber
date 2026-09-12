import React from 'react';
import { useI18n } from '@/lib/i18n';
import { fitFrameToStage, renderSurfaceFrame, viewerPointToFrameCss, type RemoteSurfaceClient, type SurfaceFrameHeader } from '@/lib/browser/remoteSurface';
import { surfaceModifiers, viewerWheelToFrameCss } from '@/lib/browser/remoteSurfaceInput';
import { useRemoteBrowserClipboard } from './useRemoteBrowserClipboard';
import { RemoteBrowserClipboardControls } from './RemoteBrowserClipboardControls';
import { RemoteBrowserContextMenu } from './RemoteBrowserContextMenu';

type Props = {
  readonly client: RemoteSurfaceClient;
  readonly activeTabId: string | null;
  readonly enabled: boolean;
  readonly onFrameFailure: (failed: boolean) => void;
  readonly onDisplayScaleChange?: (scale: number | null) => void;
  readonly onStageSize?: (size: { width: number; height: number }) => void;
  readonly onOpenDevTools?: () => void;
};
type TouchGesture = { id: number; originX: number; originY: number; x: number; y: number; scrolling: boolean };

export const RemoteBrowserCanvas: React.FC<Props> = ({ client, activeTabId, enabled, onFrameFailure, onDisplayScaleChange, onStageSize, onOpenDevTools }) => {
  const { t } = useI18n();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const touchRef = React.useRef<TouchGesture | null>(null);
  const compositionRef = React.useRef({ active: false, committed: '' });
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const [frame, setFrame] = React.useState<SurfaceFrameHeader | null>(null);
  const clipboard = useRemoteBrowserClipboard(client, activeTabId, enabled);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !globalThis.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextSize = { width: entry.contentRect.width, height: entry.contentRect.height };
      setSize(nextSize);
      client.viewport.updateStage(nextSize.width, nextSize.height);
      onStageSize?.(nextSize);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [client, onStageSize]);

  React.useEffect(() => {
    let current = true;
    setFrame(null);
    onFrameFailure(false);
    client.setFrameHandler(async (header, jpeg, isConnectionCurrent) => {
      const canvas = canvasRef.current;
      if (!canvas || header.tabId !== activeTabId) return;
      try {
        const rendered = await renderSurfaceFrame(canvas, header, jpeg, undefined, () => current && isConnectionCurrent());
        if (!current || !isConnectionCurrent()) return;
        onFrameFailure(!rendered);
        if (rendered) setFrame((previous) => previous?.width === header.width
          && previous.height === header.height && previous.scale === header.scale ? previous : header);
      } catch (error) {
        if (error instanceof Error && current && isConnectionCurrent()) onFrameFailure(true);
      }
    });
    return () => {
      current = false;
      client.setFrameHandler(null);
    };
  }, [activeTabId, client, onFrameFailure]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const point = viewerPointToFrameCss({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, frame);
      const delta = viewerWheelToFrameCss(event, rect, frame);
      if (enabled && point && delta) client.sendWheel({ ...point, ...delta, modifiers: surfaceModifiers(event) });
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [client, enabled, frame]);

  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const beforeInput = (event: InputEvent) => {
      if (event.isComposing || !enabled) return;
      if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
        event.preventDefault();
        const key = event.inputType === 'deleteContentBackward' ? 'Backspace' : 'Delete';
        client.sendKey({ eventType: 'keydown', key });
        client.sendKey({ eventType: 'keyup', key });
      }
    };
    input.addEventListener('beforeinput', beforeInput);
    return () => input.removeEventListener('beforeinput', beforeInput);
  }, [client, enabled]);

  const pointFor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!frame || !enabled) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    return viewerPointToFrameCss({ x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, frame);
  };
  const sendPointer = (event: React.PointerEvent<HTMLCanvasElement>, eventType: 'down' | 'move' | 'up') => {
    if (event.button === 2) return;
    const point = pointFor(event);
    if (point) client.sendPointer({ eventType, ...point, button: event.button === 1 ? 1 : event.button === 2 ? 2 : 0 });
  };
  const keyEvent = (event: React.KeyboardEvent, eventType: 'keydown' | 'keyup') => {
    if (event.target !== event.currentTarget && event.target !== inputRef.current) return;
    if (!enabled) return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.key === 'Unidentified') return;
    const clipboardKey = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (clipboardKey && event.key.toLowerCase() === 'v') return;
    if (clipboardKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      if (eventType === 'keydown' && !event.repeat) void clipboard.copy();
      return;
    }
    const textKey = event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.target === inputRef.current && textKey) return;
    if (event.key === 'Tab' && event.shiftKey) return;
    event.preventDefault();
    if (textKey) {
      if (eventType === 'keydown') client.sendText(event.key);
    } else client.sendKey({ eventType, key: event.key, modifiers: surfaceModifiers(event) });
  };
  const display = frame ? fitFrameToStage(frame, size) : null;
  const displayScale = display && frame ? display.width / frame.width : null;

  React.useEffect(() => {
    onDisplayScaleChange?.(displayScale);
  }, [displayScale, onDisplayScaleChange]);

  React.useEffect(() => () => { onDisplayScaleChange?.(null); }, [onDisplayScaleChange]);

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
    <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden outline-none"
      tabIndex={enabled ? 0 : -1} onKeyDown={(event) => keyEvent(event, 'keydown')} onKeyUp={(event) => keyEvent(event, 'keyup')}
      onCopy={(event) => {
        if (!enabled || (event.target !== event.currentTarget && event.target !== inputRef.current)) return;
        event.preventDefault();
        void clipboard.copy();
      }}
      onPaste={(event) => {
        if (!enabled || (event.target !== event.currentTarget && event.target !== inputRef.current)) return;
        event.preventDefault();
        clipboard.pasteText(event.clipboardData.getData('text/plain'));
      }}>
      <RemoteBrowserContextMenu client={client} enabled={enabled} canvas={canvasRef} frame={frame}
        clipboard={clipboard} onOpenDevTools={onOpenDevTools}>
      <canvas ref={canvasRef} aria-label={t('contextPanel.browser.remote.canvasAria')}
        className="block max-h-full max-w-full touch-none bg-background" style={display ?? undefined}
        onPointerDown={(event) => {
          if (!enabled) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          if (event.pointerType === 'touch') {
            touchRef.current = { id: event.pointerId, originX: event.clientX, originY: event.clientY,
              x: event.clientX, y: event.clientY, scrolling: false };
          } else {
            stageRef.current?.focus({ preventScroll: true });
            sendPointer(event, 'down');
          }
        }}
        onPointerMove={(event) => {
          const touch = touchRef.current;
          if (event.pointerType !== 'touch') { sendPointer(event, 'move'); return; }
          if (!touch || touch.id !== event.pointerId || !frame) return;
          event.preventDefault();
          touch.scrolling ||= Math.hypot(event.clientX - touch.originX, event.clientY - touch.originY) > 6;
          if (touch.scrolling) {
            const point = pointFor(event);
            const delta = viewerWheelToFrameCss({ deltaX: touch.x - event.clientX, deltaY: touch.y - event.clientY, deltaMode: 0 }, event.currentTarget.getBoundingClientRect(), frame);
            if (point && delta) client.sendWheel({ ...point, ...delta });
          }
          touch.x = event.clientX;
          touch.y = event.clientY;
        }}
        onPointerUp={(event) => {
          const touch = touchRef.current;
          if (event.pointerType !== 'touch') sendPointer(event, 'up');
          else if (touch?.id === event.pointerId && !touch.scrolling) {
            sendPointer(event, 'down');
            sendPointer(event, 'up');
          }
          touchRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (event.pointerType !== 'touch') sendPointer(event, 'up');
          touchRef.current = null;
        }}
      />
      </RemoteBrowserContextMenu>
      <textarea ref={inputRef} aria-label={t('contextPanel.browser.remote.textInputAria')}
        className="sr-only" disabled={!enabled} defaultValue=" " autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onFocus={(event) => event.currentTarget.setSelectionRange(1, 1)}
        onInput={(event) => {
          const native = event.nativeEvent;
          if (compositionRef.current.active || (native instanceof InputEvent && native.isComposing)) return;
          const input = event.currentTarget;
          const repeatsComposition = native instanceof InputEvent
            && (native.inputType === 'insertFromComposition' || native.inputType === 'insertCompositionText')
            && native.data === compositionRef.current.committed;
          const pasted = native instanceof InputEvent && native.inputType === 'insertFromPaste';
          if (enabled && !repeatsComposition && !pasted) client.sendText(input.value.replace(/^ /, ''));
          compositionRef.current.committed = '';
          input.value = ' ';
          input.setSelectionRange(1, 1);
        }}
        onCompositionStart={() => { compositionRef.current = { active: true, committed: '' }; }}
        onCompositionEnd={(event) => {
          compositionRef.current = { active: false, committed: event.data };
          if (enabled) client.sendText(event.data);
          event.currentTarget.value = ' ';
          event.currentTarget.setSelectionRange(1, 1);
        }}
      />
    </div>
      {enabled ? <RemoteBrowserClipboardControls clipboard={clipboard}
        focusInput={() => inputRef.current?.focus({ preventScroll: true })} /> : null}
    </div>
  );
};
