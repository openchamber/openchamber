import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { normalizePath } from '@/lib/pathNormalization';

/**
 * Fixed panel width. The panel is not user-resizable: it is an object inside
 * the chat rather than a docked pane, so it has no resizer and no persisted
 * width.
 */
export const WORK_STATUS_PANEL_WIDTH = 300;

/**
 * Minimum width the message column must keep for itself. Below this the panel
 * yields — a squeezed transcript costs more than the status it displaces.
 */
const WORK_STATUS_MIN_CHAT_WIDTH = 560;

/** The card's own horizontal margins (`ml-2` + `mr-4`). */
const WORK_STATUS_PANEL_GUTTER = 8 + 16;

/** Row width below which the panel gives its space back to the transcript. */
export const WORK_STATUS_REQUIRED_ROW_WIDTH =
  WORK_STATUS_PANEL_WIDTH + WORK_STATUS_PANEL_GUTTER + WORK_STATUS_MIN_CHAT_WIDTH;

type Options = {
  directory: string | null | undefined;
  isMobile: boolean;
  isVSCode: boolean;
};

type Result = {
  /** Layout can host the panel inline, regardless of the user's switch. */
  fits: boolean;
  /**
   * Attach to the flex row that contains the chat column and the panel.
   *
   * A callback ref, not an object ref: an object ref gives no signal when the
   * node attaches, so a measuring effect that reads `.current` would silently
   * observe nothing whenever the row mounts after the effect first ran, and
   * would only recover on the next unrelated dependency change.
   */
  rowRef: (node: HTMLDivElement | null) => void;
  visible: boolean;
};

/**
 * Decides whether the work-status panel may occupy space inside the chat.
 *
 * The width test measures the ROW (chat column + panel), never the chat column
 * alone. The chat column's width is an output of this decision: hiding the
 * panel widens it, which would re-satisfy a chat-width test and re-show the
 * panel, oscillating forever. The row width is independent of the panel, so it
 * is the only stable input.
 */
export const useWorkStatusVisibility = ({ directory, isMobile, isVSCode }: Options): Result => {
  const [rowNode, setRowNode] = React.useState<HTMLDivElement | null>(null);
  const [rowWidth, setRowWidth] = React.useState<number | null>(null);
  const rowRef = React.useCallback((node: HTMLDivElement | null) => { setRowNode(node); }, []);

  const directoryKey = React.useMemo(() => normalizePath(directory ?? null), [directory]);

  // Mirrors ContextPanel's own derivation: a panel with `isOpen` but no
  // resolvable active tab renders nothing, and must not displace this panel.
  const contextPanelOpen = useUIStore(
    React.useCallback(
      (state) => {
        const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
        if (!panel?.isOpen) return false;
        const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId)
          ?? panel.tabs[panel.tabs.length - 1]
          ?? null;
        return Boolean(activeTab);
      },
      [directoryKey],
    ),
  );

  // The user's own switch, persisted to server settings, gates everything
  // before layout is even measured.
  const panelEnabled = useUIStore((state) => state.workStatusPanelEnabled);

  // Split from the switch: a narrow chat is a layout fact, and the header needs
  // it to offer the panel as an overlay instead of pretending it is off.
  const layoutAllows = !isMobile && !isVSCode && !contextPanelOpen;

  // Measures the chat AREA — the container holding the chat and the context
  // panel together — not the chat row inside it.
  //
  // The row is what the context panel squeezes, and it squeezes it over a
  // 200ms animation. Measuring the row therefore reported a width that was
  // still catching up while the context panel collapsed, so this panel only
  // reappeared once that number crossed the threshold: the chat widened first
  // and narrowed again afterwards. The chat area's width does not move when
  // the context panel opens, so the reading is correct the instant it closes.
  //
  // It is also the stable input the oscillation argument needs: this panel's
  // own visibility cannot change the width being measured.
  React.useEffect(() => {
    if (!rowNode || typeof ResizeObserver === 'undefined') return undefined;

    const measured = rowNode.closest<HTMLElement>('[data-chat-area]') ?? rowNode;
    setRowWidth(measured.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setRowWidth(entry.contentRect.width);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, [rowNode]);

  const fits = layoutAllows && rowWidth !== null && rowWidth >= WORK_STATUS_REQUIRED_ROW_WIDTH;
  const visible = panelEnabled && fits;

  return { rowRef, visible, fits };
};
