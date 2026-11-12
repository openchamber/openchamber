import React from 'react';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import {
  CONTEXT_ZONE_DEFAULT_WIDTH,
  isZoneShown,
  resolveZoneActiveTab,
  showsFileTreeOnly,
  sideZoneWidth,
} from '@/lib/workspace/zones';

/**
 * Fixed panel width. The panel is not user-resizable: it is an object inside
 * the chat rather than a docked pane, so it has no resizer and no persisted
 * width.
 */
export const WORK_STATUS_PANEL_WIDTH = 300;

/**
 * Minimum width the message column must keep for itself. Below this the panel
 * yields, beside the context panel too: a squeezed transcript costs more than
 * the status it displaces.
 */
const WORK_STATUS_MIN_CHAT_WIDTH = 560;

/** The card's own horizontal margins (`ms-2` + `me-4`). */
const WORK_STATUS_PANEL_GUTTER = 8 + 16;

/** The card's column in the right slot: the card and its margins. */
export const WORK_STATUS_COLUMN_WIDTH = WORK_STATUS_PANEL_WIDTH + WORK_STATUS_PANEL_GUTTER;

/** Row width below which the panel gives its space back to the transcript. */
export const WORK_STATUS_REQUIRED_ROW_WIDTH = WORK_STATUS_COLUMN_WIDTH + WORK_STATUS_MIN_CHAT_WIDTH;

type Options = {
  isMobile: boolean;
  isVSCode: boolean;
};

type Result = {
  /** Layout can host the panel inline, regardless of the user's switch. */
  fits: boolean;
  /**
   * The chat area is wide enough for the panel's column, whether or not the
   * context panel is open. The right slot keeps the column for the card on
   * this, so closing the context panel goes straight back to it.
   */
  roomy: boolean;
  /**
   * The chat area is also wide enough for the panel's column beside the
   * context panel at the width it shows at, or will open at. Answered while
   * the context panel is closed too, so the commit that opens it already
   * knows whether the card stays.
   */
  roomyBesidePanel: boolean;
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
export const useWorkStatusVisibility = ({ isMobile, isVSCode }: Options): Result => {
  const [rowNode, setRowNode] = React.useState<HTMLDivElement | null>(null);
  // Only the threshold decisions are state: the chat area's width changes on
  // every frame of a sidebar animation, and storing the width itself
  // re-rendered the whole chat on each of those frames.
  const [wideEnough, setWideEnough] = React.useState<boolean | null>(null);
  const [wideEnoughBesidePanel, setWideEnoughBesidePanel] = React.useState(false);
  const rowRef = React.useCallback((node: HTMLDivElement | null) => { setRowNode(node); }, []);

  // Keyed exactly like the rail and the panel itself: whichever directory the
  // app is effectively on, not the directory this panel reports about. A chat
  // with no project reports on nothing, and looking the context panel up under
  // that empty key answered "closed" while it was plainly open on screen.
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = React.useMemo(
    () => (effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : ''),
    [effectiveDirectory],
  );

  // Mirrors ContextPanel's own derivation: a zone with `isOpen` but no
  // resolvable tab of its own renders nothing, and must not displace this
  // panel. Only the right zone shares this card's slot; the left and bottom
  // zones leave it in place.
  const contextPanelOpen = useUIStore(
    React.useCallback(
      (state) => isZoneShown(
        directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined,
        state.contextSurfaceZones,
        'right',
      ),
      [directoryKey],
    ),
  );

  // The width the right zone shows at, or opens at: its tab's width even
  // while closed, so opening it changes no threshold. An expanded zone takes
  // everything but a narrow chat column, so the card never stays beside it;
  // Files showing only its tree never expands (ContextPanel's isTreeOnly).
  const contextPanelWidth = useUIStore(
    React.useCallback(
      (state) => {
        const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
        const tab = panel ? resolveZoneActiveTab(panel, state.contextSurfaceZones, 'right') : null;
        return panel && tab ? sideZoneWidth(panel, tab, 'right', state) : CONTEXT_ZONE_DEFAULT_WIDTH;
      },
      [directoryKey],
    ),
  );
  const contextPanelExpanded = useUIStore(
    React.useCallback(
      (state) => {
        const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
        if (!panel?.expanded) return false;
        const tab = isZoneShown(panel, state.contextSurfaceZones, 'right')
          ? resolveZoneActiveTab(panel, state.contextSurfaceZones, 'right')
          : null;
        return tab !== null && !showsFileTreeOnly(panel, tab, state);
      },
      [directoryKey],
    ),
  );

  // The user's own switch, persisted to server settings, gates everything
  // before layout is even measured.
  const panelEnabled = useUIStore((state) => state.workStatusPanelEnabled);

  // Measures the chat AREA — the container holding the chat and the context
  // panel together — not the chat row inside it.
  //
  // The row is what the context panel squeezes, and it squeezes it over its
  // width animation. Measuring the row therefore reported a width that was
  // still catching up while the context panel collapsed, so this panel only
  // reappeared once that number crossed the threshold: the chat widened first
  // and narrowed again afterwards. The chat area's width does not move when
  // the context panel opens, so the reading is correct the instant it closes.
  //
  // It is also the stable input the oscillation argument needs: this panel's
  // own visibility cannot change the width being measured. Nor can the context
  // panel's: its width is the user's setting, read from the store.
  const areaWidthRef = React.useRef<number | null>(null);
  const contextPanelWidthRef = React.useRef(contextPanelWidth);
  contextPanelWidthRef.current = contextPanelWidth;
  const applyAreaWidth = React.useCallback((width: number) => {
    areaWidthRef.current = width;
    setWideEnough(width >= WORK_STATUS_REQUIRED_ROW_WIDTH);
    setWideEnoughBesidePanel(width >= WORK_STATUS_REQUIRED_ROW_WIDTH + contextPanelWidthRef.current);
  }, []);

  React.useEffect(() => {
    if (!rowNode || typeof ResizeObserver === 'undefined') return undefined;

    const measured = rowNode.closest<HTMLElement>('[data-chat-area]') ?? rowNode;
    applyAreaWidth(measured.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyAreaWidth(entry.contentRect.width);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, [applyAreaWidth, rowNode]);

  // A resized context panel or another surface in it moves the threshold, not
  // the area: re-decided from the last reading, before paint, so the slot
  // animates once to the final width.
  React.useLayoutEffect(() => {
    if (areaWidthRef.current !== null) applyAreaWidth(areaWidthRef.current);
  }, [applyAreaWidth, contextPanelWidth]);

  const roomy = !isMobile && !isVSCode && wideEnough === true;
  const roomyBesidePanel = roomy && wideEnoughBesidePanel && !contextPanelExpanded;
  // Split from the switch: a narrow chat is a layout fact, and the header needs
  // it to offer the panel as an overlay instead of pretending it is off.
  const fits = contextPanelOpen ? roomyBesidePanel : roomy;
  const visible = panelEnabled && fits;

  return { rowRef, visible, fits, roomy, roomyBesidePanel };
};
