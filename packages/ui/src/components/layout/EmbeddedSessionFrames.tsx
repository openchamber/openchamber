import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ContextPanelTab } from '@/stores/useUIStore';

export type EmbeddedSessionFramesHandle = {
  scheduleGeometrySync: () => void;
  observeSlot: (element: HTMLElement) => void;
  unobserveSlot: (element: HTMLElement) => void;
};

type SharedProps = {
  tabs: readonly ContextPanelTab[];
  directoryKey: string;
  visibleTileIds?: ReadonlySet<string>;
};

type ContainedProps = SharedProps & {
  mode: 'contained';
  activeTabID: string | null;
};

type TiledProps = SharedProps & {
  mode: 'tiled';
  tileGroupIds: ReadonlyMap<string, string>;
  slotElements: React.RefObject<Map<string, HTMLElement>>;
};

type EmbeddedSessionFramesProps = ContainedProps | TiledProps;

const getSessionIDFromDedupeKey = (dedupeKey: string | undefined): string | null => {
  if (!dedupeKey || !dedupeKey.startsWith('session:')) return null;
  const sessionID = dedupeKey.slice('session:'.length).trim();
  return sessionID || null;
};

const buildEmbeddedSessionChatURL = (sessionID: string, directory: string | null, readOnly: boolean): string => {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('ocPanel', 'session-chat');
  url.searchParams.set('sessionId', sessionID);
  if (readOnly) url.searchParams.set('readOnly', '1');
  else url.searchParams.delete('readOnly');
  if (directory && directory.trim().length > 0) url.searchParams.set('directory', directory);
  else url.searchParams.delete('directory');
  url.hash = '';
  return url.toString();
};

export const EmbeddedSessionFrames = React.forwardRef<EmbeddedSessionFramesHandle, EmbeddedSessionFramesProps>(
  function EmbeddedSessionFrames(props, ref) {
    const { t } = useI18n();
    const { themeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const frameRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map());
    const geometryFrameRef = React.useRef<number | null>(null);
    const chatTabs = React.useMemo(() => props.tabs.filter((tab) => tab.mode === 'chat'), [props.tabs]);
    const frameSources = React.useMemo(() => {
      const sources = new Map<string, { sessionID: string; src: string }>();
      for (const tab of chatTabs) {
        const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
        if (!sessionID) continue;
        const src = buildEmbeddedSessionChatURL(sessionID, props.directoryKey || null, tab.readOnly);
        if (src) sources.set(tab.id, { sessionID, src });
      }
      return sources;
    }, [chatTabs, props.directoryKey]);

    const propsRef = React.useRef(props);
    propsRef.current = props;

    const syncGeometry = React.useCallback(() => {
      const current = propsRef.current;
      if (current.mode !== 'tiled') return;
      const host = hostRef.current;
      if (!host) return;
      // Batch all layout READS before any style WRITES to avoid forced reflow per frame.
      const hostRect = host.getBoundingClientRect();
      const placements: { frame: HTMLIFrameElement; rect: DOMRect | null }[] = [];
      for (const [tabID, frame] of frameRefs.current) {
        const groupID = current.tileGroupIds.get(tabID);
        const slot = groupID ? current.slotElements.current.get(groupID) : undefined;
        const visible = current.visibleTileIds?.has(tabID) === true;
        placements.push({ frame, rect: slot && visible ? slot.getBoundingClientRect() : null });
      }
      for (const { frame, rect } of placements) {
        if (!rect) {
          frame.style.display = 'none';
          continue;
        }
        frame.style.display = 'block';
        frame.style.transform = `translate3d(${rect.left - hostRect.left}px, ${rect.top - hostRect.top}px, 0)`;
        frame.style.width = `${rect.width}px`;
        frame.style.height = `${rect.height}px`;
      }
    }, []);

    const scheduleGeometrySync = React.useCallback(() => {
      if (geometryFrameRef.current !== null) return;
      geometryFrameRef.current = window.requestAnimationFrame(() => {
        geometryFrameRef.current = null;
        syncGeometry();
      });
    }, [syncGeometry]);

    const resizeObserverRef = React.useRef<ResizeObserver | null>(null);
    const getResizeObserver = React.useCallback((): ResizeObserver | null => {
      if (typeof ResizeObserver === 'undefined') return null;
      if (!resizeObserverRef.current) {
        resizeObserverRef.current = new ResizeObserver(() => scheduleGeometrySync());
      }
      return resizeObserverRef.current;
    }, [scheduleGeometrySync]);

    const observeSlot = React.useCallback((element: HTMLElement) => {
      getResizeObserver()?.observe(element);
      scheduleGeometrySync();
    }, [getResizeObserver, scheduleGeometrySync]);

    const unobserveSlot = React.useCallback((element: HTMLElement) => {
      resizeObserverRef.current?.unobserve(element);
    }, []);

    React.useImperativeHandle(ref, () => ({ scheduleGeometrySync, observeSlot, unobserveSlot }), [scheduleGeometrySync, observeSlot, unobserveSlot]);

    const postThemeSyncToEmbeddedChat = React.useCallback(() => {
      if (typeof window === 'undefined') return;
      const payload = { themeMode, lightThemeId, darkThemeId, currentTheme };
      for (const frame of frameRefs.current.values()) {
        const frameWindow = frame.contentWindow;
        if (!frameWindow) continue;
        const directThemeSync = (frameWindow as unknown as {
          __openchamberApplyThemeSync?: (themePayload: typeof payload) => void;
        }).__openchamberApplyThemeSync;
        if (typeof directThemeSync === 'function') {
          try {
            directThemeSync(payload);
            continue;
          } catch {
            // fallback to postMessage below
          }
        }
        frameWindow.postMessage({ type: 'openchamber:theme-sync', payload }, window.location.origin);
      }
    }, [currentTheme, darkThemeId, lightThemeId, themeMode]);

    const postEmbeddedVisibilityToChats = React.useCallback(() => {
      if (typeof window === 'undefined') return;
      const current = propsRef.current;
      for (const [tabID, frame] of frameRefs.current.entries()) {
        const frameWindow = frame.contentWindow;
        if (!frameWindow) continue;
        const visible = current.visibleTileIds ? current.visibleTileIds.has(tabID) : current.mode === 'contained' && current.activeTabID === tabID;
        const payload = { visible };
        const directVisibilitySync = (frameWindow as unknown as {
          __openchamberSetEmbeddedVisibility?: (visibilityPayload: typeof payload) => void;
        }).__openchamberSetEmbeddedVisibility;
        if (typeof directVisibilitySync === 'function') {
          try {
            directVisibilitySync(payload);
            continue;
          } catch {
            // fallback to postMessage below
          }
        }
        frameWindow.postMessage({ type: 'openchamber:embedded-visibility', payload }, window.location.origin);
      }
    }, []);

    const visibilityKey = props.visibleTileIds
      ? [...props.visibleTileIds].sort().join('|')
      : props.mode === 'contained'
        ? `active:${props.activeTabID ?? ''}`
        : '';

    React.useLayoutEffect(() => {
      postEmbeddedVisibilityToChats();
      scheduleGeometrySync();
    }, [visibilityKey, postEmbeddedVisibilityToChats, scheduleGeometrySync]);

    React.useLayoutEffect(() => {
      postThemeSyncToEmbeddedChat();
    }, [postThemeSyncToEmbeddedChat]);

    const isTiled = props.mode === 'tiled';

    React.useLayoutEffect(() => {
      if (!isTiled) return;
      const host = hostRef.current;
      const observer = getResizeObserver();
      if (host && observer) observer.observe(host);
      return () => {
        if (host) resizeObserverRef.current?.unobserve(host);
      };
    }, [isTiled, getResizeObserver]);

    React.useEffect(() => () => {
      if (geometryFrameRef.current !== null) window.cancelAnimationFrame(geometryFrameRef.current);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    }, []);

    return (
      <div ref={hostRef} className={props.mode === 'tiled' ? 'pointer-events-none absolute inset-0 z-10' : 'absolute inset-0'}>
        {chatTabs.map((tab) => {
          const source = frameSources.get(tab.id);
          if (!source) return null;
          const visible = props.visibleTileIds ? props.visibleTileIds.has(tab.id) : props.mode === 'contained' && props.activeTabID === tab.id;
          return (
            <iframe
              key={tab.id}
              ref={(node) => {
                if (node) frameRefs.current.set(tab.id, node);
                else frameRefs.current.delete(tab.id);
              }}
              src={source.src}
              title={t('contextPanel.iframe.sessionChatTitle', { sessionID: source.sessionID })}
              className={cn('absolute left-0 top-0 border-0 bg-background', props.mode === 'contained' && 'h-full w-full', visible ? 'pointer-events-auto' : 'hidden')}
              onLoad={() => {
                postThemeSyncToEmbeddedChat();
                postEmbeddedVisibilityToChats();
                scheduleGeometrySync();
              }}
            />
          );
        })}
      </div>
    );
  },
);
