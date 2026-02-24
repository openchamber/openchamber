import React from "react";
import { RiArrowUpSLine, RiArrowDownSLine, RiCloseCircleLine } from "@remixicon/react";
import { cn } from "@/lib/utils";
import { useTodoStore, type TodoItem, type TodoStatus } from "@/stores/useTodoStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useUIStore } from "@/stores/useUIStore";
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";
import { isVSCodeRuntime } from "@/lib/desktop";

const statusConfig: Record<TodoStatus, { textClassName: string }> = {
  in_progress: {
    textClassName: "text-foreground",
  },
  pending: {
    textClassName: "text-foreground",
  },
  completed: {
    textClassName: "text-muted-foreground line-through",
  },
  cancelled: {
    textClassName: "text-muted-foreground line-through",
  },
};

interface TodoItemRowProps {
  todo: TodoItem;
}

const TodoItemRow: React.FC<TodoItemRowProps> = ({ todo }) => {
  const config = statusConfig[todo.status] || statusConfig.pending;

  return (
    <div className="flex items-start min-w-0 py-0.5">
      <span
        className={cn(
          "flex-1 typography-ui-label",
          config.textClassName
        )}
      >
        {todo.content}
      </span>
    </div>
  );
};

const EMPTY_TODOS: TodoItem[] = [];

interface StatusRowProps {
  // Working state
  isWorking: boolean;
  statusText: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  wasAborted?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  // Abort state (for mobile/vscode)
  showAbort?: boolean;
  onAbort?: () => void;
  // Abort status display
  showAbortStatus?: boolean;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  wasAborted,
  abortActive,
  retryInfo,
  showAbort,
  onAbort,
  showAbortStatus,
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const todos = useTodoStore((state) =>
    currentSessionId ? state.sessionTodos.get(currentSessionId) ?? EMPTY_TODOS : EMPTY_TODOS
  );
  const loadTodos = useTodoStore((state) => state.loadTodos);
  const { isMobile } = useUIStore();
  const isCompact = isMobile || isVSCodeRuntime();

  // Load todos when session changes
  React.useEffect(() => {
    if (currentSessionId) {
      void loadTodos(currentSessionId);
    }
  }, [currentSessionId, loadTodos]);

  // Filter out cancelled todos for display, sort by status priority
  const visibleTodos = React.useMemo(() => {
    const statusOrder: Record<TodoStatus, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
      cancelled: 3,
    };

    return [...todos]
      .filter((todo) => todo.status !== "cancelled")
      .sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
  }, [todos]);

  // Find the current active todo (first in_progress, or first pending)
  const activeTodo = React.useMemo(() => {
    return (
      visibleTodos.find((t) => t.status === "in_progress") ||
      visibleTodos.find((t) => t.status === "pending") ||
      null
    );
  }, [visibleTodos]);

  // Calculate progress
  const progress = React.useMemo(() => {
    const total = todos.filter((t) => t.status !== "cancelled").length;
    const completed = todos.filter((t) => t.status === "completed").length;
    return { completed, total };
  }, [todos]);

  const hasActiveTodos = visibleTodos.some((t) => t.status === "in_progress" || t.status === "pending");
  // Original logic from ChatInput
  const shouldRenderPlaceholder = !showAbortStatus && (wasAborted || !abortActive);

  // Keep StatusRow rendered while:
  // - isWorking (active session)
  // - wasAborted / showAbortStatus
  // - hasActiveTodos
  const hasContent =
    isWorking ||
    Boolean(wasAborted) ||
    Boolean(showAbortStatus) ||
    hasActiveTodos;

  // Close popover when clicking outside
  const popoverRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  const toggleExpanded = () => setIsExpanded((prev) => !prev);

  // Abort button for mobile/vscode
  const abortButton = showAbort && onAbort ? (
    <button
      type="button"
      onClick={onAbort}
      className="flex items-center justify-center h-[1.2rem] w-[1.2rem] text-[var(--status-error)] transition-opacity hover:opacity-80 focus-visible:outline-none flex-shrink-0"
      aria-label="Stop generating"
    >
      <RiCloseCircleLine size={18} aria-hidden="true" />
    </button>
  ) : null;

  // Todo trigger button
  const todoTrigger = hasActiveTodos ? (
    <button
      type="button"
      onClick={toggleExpanded}
      className="flex items-center gap-1 flex-shrink-0 text-muted-foreground"
    >
      {/* Desktop: show task text; Mobile/VSCode: just "Tasks" */}
      {!isCompact && activeTodo ? (
        <span className="typography-ui-label text-foreground truncate max-w-[200px]">
          {activeTodo.content}
        </span>
      ) : (
        <span className="typography-ui-label">Tasks</span>
      )}
      <span className="typography-meta">
        {progress.completed}/{progress.total}
      </span>
      {isExpanded ? (
        <RiArrowUpSLine className="h-3.5 w-3.5" />
      ) : (
        <RiArrowDownSLine className="h-3.5 w-3.5" />
      )}
    </button>
  ) : null;

  // Don't render if nothing to show
  if (!hasContent) {
    return null;
  }

  return (
    <div className="chat-column mb-1" style={{ containerType: "inline-size" }}>
      <div className="flex items-center justify-between pr-[2ch] py-0.5 gap-2 h-[1.2rem]">
        {/* Left: Abort status or Working placeholder */}
        <div className="flex-1 flex items-center overflow-hidden min-w-0">
          {showAbortStatus ? (
            <div className="flex h-full items-center text-[var(--status-error)] pl-[2ch]">
              <span className="flex items-center gap-1.5 typography-ui-label">
                <RiCloseCircleLine size={16} aria-hidden="true" />
                Aborted
              </span>
            </div>
          ) : shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
            />
          ) : null}
        </div>

        {/* Right: Abort (mobile only) + Todo */}
        <div className="relative flex items-center gap-2 flex-shrink-0" ref={popoverRef}>
          {abortButton}
          {todoTrigger}

          {/* Popover dropdown */}
          {isExpanded && hasActiveTodos && (
            <div
              style={{ maxWidth: "calc(100cqw - 4ch)" }}
              className={cn(
                "absolute right-0 bottom-full mb-1 z-50",
                "w-max min-w-[200px]",
                "rounded-xl border border-border bg-background shadow-md",
                "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                "duration-150"
              )}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="typography-ui-label text-muted-foreground">Tasks</span>
                <span className="typography-meta text-muted-foreground">
                  {progress.completed}/{progress.total}
                </span>
              </div>

              {/* Todo list */}
              <div className="px-3 py-2 max-h-[200px] overflow-y-auto divide-y divide-border">
                {visibleTodos.map((todo) => (
                  <TodoItemRow key={todo.id} todo={todo} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
