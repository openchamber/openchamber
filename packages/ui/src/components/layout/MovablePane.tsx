import React from 'react';
import { createPortal } from 'react-dom';
import type { ContextZone } from '@/lib/workspace/zones';
import { useZoneHostsStore } from './zoneHosts';

type HostParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

/**
 * Renders a keep-alive surface into the body of a zone. The content lives in
 * one detached element for the pane's whole life; changing `zone` moves that
 * element, so React keeps the component and the DOM keeps its state: the
 * editor its text and undo, the terminal its session. `moveBefore` keeps
 * focus, scroll and iframes through the move where the engine has it. An
 * Electron webview reloads on any move; it moves only when the user moves its
 * surface.
 *
 * The element is `display: contents`, so the pane's own wrapper is laid out
 * by the zone body as if it were a direct child.
 */
export const MovablePane: React.FC<{ zone: ContextZone; children: React.ReactNode }> = ({ zone, children }) => {
  const [node] = React.useState(() => {
    const element = document.createElement('div');
    element.style.display = 'contents';
    return element;
  });
  const host = useZoneHostsStore((state) => state.body[zone]);

  React.useLayoutEffect(() => {
    // The frame registers its body from a ref, earlier in the same commit, so
    // a pane lands in its final zone on first attach.
    const parent: HostParent | null = host ?? useZoneHostsStore.getState().body[zone];
    if (!parent) {
      node.remove();
      return;
    }
    if (node.parentElement === parent) return;
    const focused = document.activeElement;
    if (parent.moveBefore && node.isConnected) {
      parent.moveBefore(node, null);
    } else {
      parent.append(node);
    }
    if (focused instanceof HTMLElement && node.contains(focused) && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  }, [host, node, zone]);

  React.useLayoutEffect(() => () => node.remove(), [node]);

  return createPortal(children, node);
};
