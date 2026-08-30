import React from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useKeybinds } from "@/hooks/useKeybind";
import { useI18n } from "@/lib/i18n";
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution";
import { shortcutRegistry } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { useSessionMRUStore } from "@/stores/useSessionMRUStore";
import { useUIStore } from "@/stores/useUIStore";
import {
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from "@/stores/useGlobalSessionsStore";
import { useSessionUIStore } from "@/sync/session-ui-store";

const CycleDirections = {
  TowardOlder: -1,
  TowardNewer: 1,
} as const;

type CycleDirection = (typeof CycleDirections)[keyof typeof CycleDirections];

type SessionCycleState = {
  frozenSessionIds: string[];
  previewIndex: number;
};

const PREVIEW_MOVE_THROTTLE_MS = 25;

const newPreviewIndex = (
  currentIndex: number,
  sessionCount: number,
  cycleDirection: CycleDirection,
): number => (currentIndex + cycleDirection + sessionCount) % sessionCount;

export function SessionMRUSwitcher(): React.ReactElement | null {
  const { t } = useI18n();
  const activeSessionIds = useGlobalSessionsStore(
    (state) => state.structure.activeSessionIds,
  );
  const entityById = useGlobalSessionsStore((state) => state.entityById);
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore(
    (state) => state.availableWorktreesByProject,
  );
  const [cycleState, setCycleState] = React.useState<SessionCycleState | null>(
    null,
  );
  const cycleStateRef = React.useRef<SessionCycleState | null>(null);
  const selectedRowRef = React.useRef<HTMLButtonElement | null>(null);
  const nextPreviewMoveAllowedAtRef = React.useRef(0);

  const updateCycleState = React.useCallback(
    (nextCycleState: SessionCycleState | null) => {
      cycleStateRef.current = nextCycleState;
      setCycleState(nextCycleState);
    },
    [],
  );

  /**
   * Starts one keyboard cycling interaction from the current MRU history.
   *
   * The interaction receives an oldest-to-newest copy containing only sessions
   * that can still be rendered. This copy stays frozen while Ctrl is held, so
   * active-session updates cannot reorder the list under the preview cursor.
   * The first key press moves one entry in cycleDirection from the current
   * session. Returning true tells the shortcut dispatcher that this component
   * handled the key, including when fewer than two sessions are available.
   */
  const beginCycle = React.useCallback(
    (cycleDirection: CycleDirection): boolean => {
      if (!useUIStore.getState().recentSessionCyclingEnabled) return false;

      const globalSessions = useGlobalSessionsStore.getState();
      const activeSessionIdSet = new Set(
        globalSessions.structure.activeSessionIds,
      );
      const recordedSessionIds = useSessionMRUStore.getState().sessionIds;

      // Create the frozen snapshot used for this entire Ctrl-held interaction.
      // Preserve the store's oldest-to-newest order so later MRU updates cannot
      // reorder the list or move the preview cursor while the user is cycling.
      const frozenSessionIds = recordedSessionIds.filter((sessionId) => {
        const session = globalSessions.entityById.get(sessionId);
        return (
          activeSessionIdSet.has(sessionId) &&
          session &&
          !session.time?.archived
        );
      });

      if (frozenSessionIds.length === 0) return true;

      const currentSessionId = useSessionUIStore.getState().currentSessionId;
      let currentIndex = frozenSessionIds.indexOf(currentSessionId ?? "");
      if (currentIndex < 0) {
        currentIndex = cycleDirection === CycleDirections.TowardOlder ? 0 : -1;
      }

      updateCycleState({
        frozenSessionIds,
        previewIndex: newPreviewIndex(
          currentIndex,
          frozenSessionIds.length,
          cycleDirection,
        ),
      });
      nextPreviewMoveAllowedAtRef.current =
        Date.now() + PREVIEW_MOVE_THROTTLE_MS;
      return true;
    },
    [updateCycleState],
  );

  const movePreview = React.useCallback(
    (cycleDirection: CycleDirection) => {
      const currentCycleState = cycleStateRef.current;
      if (!currentCycleState) return;
      updateCycleState({
        ...currentCycleState,
        previewIndex: newPreviewIndex(
          currentCycleState.previewIndex,
          currentCycleState.frozenSessionIds.length,
          cycleDirection,
        ),
      });
    },
    [updateCycleState],
  );

  const cancelCycle = React.useCallback(() => {
    updateCycleState(null);
  }, [updateCycleState]);

  const commitCycle = React.useCallback(() => {
    const currentCycleState = cycleStateRef.current;
    if (!currentCycleState) return;

    const { currentSessionId } = useSessionUIStore.getState();
    const selectedSessionId =
      currentCycleState.frozenSessionIds[currentCycleState.previewIndex];
    if (!selectedSessionId || selectedSessionId === currentSessionId) return;

    const globalSessions = useGlobalSessionsStore.getState();
    if (!globalSessions.structure.activeSessionIds.includes(selectedSessionId))
      return;

    const selectedSession = globalSessions.entityById.get(selectedSessionId);
    updateCycleState(null);

    if (!selectedSession || selectedSession.time?.archived) return;

    useSessionUIStore
      .getState()
      .setCurrentSession(
        selectedSession.id,
        resolveGlobalSessionDirectory(selectedSession),
      );
  }, [updateCycleState]);

  useKeybinds({
    cycle_recent_sessions_forward: () =>
      beginCycle(CycleDirections.TowardOlder),
    cycle_recent_sessions_backward: () =>
      beginCycle(CycleDirections.TowardNewer),
  });

  // Suspend normal application shortcuts while this interaction owns the keyboard.
  React.useLayoutEffect(() => {
    if (!cycleState) return;
    return shortcutRegistry.suspend();
  }, [cycleState]);

  // Handle repeated Tab presses locally, then commit or cancel when the held interaction ends.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!cycleStateRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelCycle();
        return;
      }
      const isConfiguredKeyCombination = event.key === "Tab" && event.ctrlKey;
      if (!isConfiguredKeyCombination) return;
      event.preventDefault();
      event.stopPropagation();

      // Throttle to prevent aggressive preview movement speed when the user holds Tab
      // because some devices can have excessive key repeat rates.
      // The first movement happens immediately,
      // rapid repeats are ignored for PREVIEW_MOVE_THROTTLE_MS.
      const now = Date.now();
      if (now < nextPreviewMoveAllowedAtRef.current) return;
      nextPreviewMoveAllowedAtRef.current = now + PREVIEW_MOVE_THROTTLE_MS;

      movePreview(
        event.shiftKey
          ? CycleDirections.TowardNewer
          : CycleDirections.TowardOlder,
      );
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" && cycleStateRef.current) commitCycle();
    };
    const handleBlur = () => cancelCycle();

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [cancelCycle, commitCycle, movePreview]);

  // Keep the previewed session visible when cycling through a list that overflows the panel.
  React.useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [cycleState?.previewIndex]);

  if (!cycleState) return null;

  // Resolve the frozen MRU IDs into the session and project data needed by each row.
  // The frozen snapshot stays oldest-to-newest for cycling logic, but the UI candidates
  // should be reversed so the newest session renders at the top of switcher. A session can be
  // archived or removed while the switcher is open, so omit IDs that are no longer
  // active. Preserve each ID's original frozen index as previewIndex so keyboard
  // selection still points at the same snapshot entry after filtering or rendering
  // in reverse order.
  const activeSessionIdSet = new Set(activeSessionIds);
  const rowsToRender = [];
  for (let i = cycleState.frozenSessionIds.length - 1; i >= 0; i--) {
    const sessionId = cycleState.frozenSessionIds[i];
    if (!activeSessionIdSet.has(sessionId)) continue;
    const session = entityById.get(sessionId);
    if (!session || session.time?.archived) continue;
    const directory = resolveGlobalSessionDirectory(session);
    const project = resolveProjectForSessionDirectory(
      projects,
      availableWorktreesByProject,
      directory,
    );
    rowsToRender.push({
      session,
      previewIndex: i,
      projectLabel: project?.label?.trim() || null,
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancelCycle();
      }}
    >
      <DialogContent
        initialFocus={false}
        showCloseButton={false}
        onContextMenu={(event) => event.preventDefault()}
        className="oc-glass-popover oc-glass-floating w-[min(44rem,calc(100vw-2rem))] max-w-none gap-1 overflow-hidden rounded-2xl p-2"
      >
        <DialogTitle className="px-3 pb-1 pt-2 typography-ui-label font-normal text-muted-foreground">
          {t("sessions.mruSwitcher.title")}
        </DialogTitle>
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto" role="listbox">
          {rowsToRender.map(({ session, previewIndex, projectLabel }) => {
            const selected = previewIndex === cycleState.previewIndex;
            return (
              <button
                key={session.id}
                ref={selected ? selectedRowRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                className={cn(
                  "flex w-full items-center gap-6 rounded-xl px-3 py-2 text-left typography-ui-label outline-hidden",
                  selected
                    ? "bg-interactive-selection text-interactive-selection-foreground"
                    : "text-foreground hover:bg-interactive-hover",
                )}
                onPointerMove={() => {
                  if (previewIndex !== cycleState.previewIndex) {
                    updateCycleState({ ...cycleState, previewIndex });
                  }
                }}
                onClick={() => {
                  cycleStateRef.current = { ...cycleState, previewIndex };
                  commitCycle();
                }}
              >
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                {projectLabel ? (
                  <span
                    className={cn(
                      "max-w-[40%] shrink-0 truncate typography-meta",
                      selected
                        ? "text-interactive-selection-foreground/70"
                        : "text-muted-foreground",
                    )}
                  >
                    {projectLabel}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
