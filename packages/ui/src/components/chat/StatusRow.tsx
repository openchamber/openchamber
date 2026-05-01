import React from "react";
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  RiArrowDownSLine,
  RiArrowUpDoubleLine,
  RiArrowUpSLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiRecordCircleLine,
  RiTimeLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import { useDirectorySync } from "@/sync/sync-context";
import type { Todo } from "@opencode-ai/sdk/v2/client";

// Compat aliases for old TodoItem shape
type TodoItem = Todo & { id?: string };
type TodoStatus = string;
type TodoPriority = string;
import { useUIStore } from "@/stores/useUIStore";
import { useTodosPersistStore } from "@/stores/useTodosPersistStore";
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";
import { isVSCodeRuntime } from "@/lib/desktop";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";

const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

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

const priorityClassName: Record<TodoPriority, string> = {
  high: "text-[var(--status-warning)]",
  medium: "text-muted-foreground",
  low: "text-muted-foreground/70",
};

const priorityIcon: Record<TodoPriority, React.ReactNode> = {
  high: <RiArrowUpDoubleLine className="h-3.5 w-3.5" aria-hidden="true" />,
  medium: <RiArrowUpSLine className="h-3.5 w-3.5" aria-hidden="true" />,
  low: <RiArrowDownSLine className="h-3.5 w-3.5" aria-hidden="true" />,
};

const statusLabelKey: Record<TodoStatus, string> = {
  in_progress: "chat.statusRow.todo.status.inProgress",
  pending: "chat.statusRow.todo.status.pending",
  completed: "chat.statusRow.todo.status.completed",
  cancelled: "chat.statusRow.todo.status.cancelled",
};

const priorityLabelKey: Record<TodoPriority, string> = {
  high: "chat.statusRow.todo.priority.high",
  medium: "chat.statusRow.todo.priority.medium",
  low: "chat.statusRow.todo.priority.low",
};

interface TodoItemRowProps {
  todo: TodoItem;
}

const TodoItemRow: React.FC<TodoItemRowProps> = ({ todo }) => {
  const { t } = useI18n();
  const config = statusConfig[todo.status] || statusConfig.pending;
  const statusKey = statusLabelKey[todo.status] ?? statusLabelKey.pending;
  const priorityKey = priorityLabelKey[todo.priority] ?? priorityLabelKey.medium;

  const statusIcon =
    todo.status === "in_progress" ? (
      <RiRecordCircleLine className="h-3.5 w-3.5 text-[var(--status-info)]" aria-hidden="true" />
    ) : todo.status === "completed" ? (
      <RiCheckboxCircleLine className="h-3.5 w-3.5 text-[var(--status-success)]" aria-hidden="true" />
    ) : (
      <RiTimeLine className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    );

  return (
    <div className="flex items-center min-w-0 py-0.5 gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex-shrink-0">{statusIcon}</span>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          {t(statusKey as never)}
        </TooltipContent>
      </Tooltip>
      <span
        className={cn(
          "flex-1 typography-ui-label",
          config.textClassName
        )}
      >
        {todo.content}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "typography-meta flex items-center justify-center flex-shrink-0 leading-none",
              priorityClassName[todo.priority] ?? priorityClassName.medium
            )}
          >
            {priorityIcon[todo.priority] ?? priorityIcon.medium}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {t(priorityKey as never)}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

const EMPTY_TODOS: TodoItem[] = [];

interface StatusRowProps {
  // Working state
  isWorking?: boolean;
  statusText?: string | null;
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
  showAssistantStatus?: boolean;
  showTodos?: boolean;
  agentName?: string;
  leftAccessory?: React.ReactNode;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  statusText = null,
  isGenericStatus,
  isWaitingForPermission,
  wasAborted,
  abortActive,
  retryInfo,
  showAbort,
  onAbort,
  showAbortStatus,
  showAssistantStatus = true,
  showTodos = true,
  agentName,
  leftAccessory,
}) => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const todosRecord = useDirectorySync((state) => state.todo);
  const persistedSessionTodos = useTodosPersistStore(
    React.useCallback(
      (state) => (currentSessionId ? state.sessions[currentSessionId]?.todos : undefined),
      [currentSessionId],
    ),
  );
  const todos: TodoItem[] = React.useMemo(() => {
    if (!currentSessionId) return EMPTY_TODOS;
    const live = todosRecord[currentSessionId];
    if (live && live.length > 0) return live;
    return persistedSessionTodos ?? EMPTY_TODOS;
  }, [todosRecord, persistedSessionTodos, currentSessionId]);
  const isMobile = useUIStore((state) => state.isMobile);
  const isCompact = isMobile || isVSCodeRuntime();

  // Filter out cancelled todos for display and keep original order.
  // This prevents items from jumping around when status changes.
  const visibleTodos = React.useMemo(() => {
    return todos.filter((todo) => todo.status !== "cancelled");
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

  const statusSummary = React.useMemo(() => {
    const active = visibleTodos.filter((t) => t.status === "in_progress").length;
    const left = visibleTodos.filter((t) => t.status === "in_progress" || t.status === "pending").length;
    return { active, left };
  }, [visibleTodos]);

  const hasTodoContent = showTodos && statusSummary.left > 0;
  const hasAssistantContent = showAssistantStatus && (
    isWorking ||
    Boolean(wasAborted) ||
    Boolean(showAbortStatus)
  );
  const hasLeftAccessory = Boolean(leftAccessory);
  // Original logic from ChatInput
  const shouldRenderPlaceholder = !showAbortStatus && (wasAborted || !abortActive);

  const hasContent = hasAssistantContent || hasTodoContent || hasLeftAccessory;

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
  const todoSummaryLabel = t('chat.statusRow.summary.activeLeft', {
    active: statusSummary.active,
    left: statusSummary.left,
  });

  // Abort button for mobile/vscode
  const abortButton = showAbort && onAbort ? (
    <button
      type="button"
      onClick={onAbort}
      className="flex items-center justify-center h-[1.2rem] w-[1.2rem] text-[var(--status-error)] transition-opacity hover:opacity-80 focus-visible:outline-none flex-shrink-0"
      aria-label={t('chat.statusRow.actions.stopGeneratingAria')}
    >
      <RiCloseCircleLine size={18} aria-hidden="true" />
    </button>
  ) : null;

  // Todo trigger button
  const todoTrigger = hasTodoContent ? (
    <button
      type="button"
      onClick={toggleExpanded}
      className="flex items-center gap-1 flex-shrink-0 text-muted-foreground"
      aria-label={todoSummaryLabel}
      title={todoSummaryLabel}
    >
      {/* Desktop: show task text; Mobile/VSCode: just "Tasks" */}
      {!isCompact && activeTodo ? (
        <span className="status-row__active-todo typography-ui-label text-foreground truncate max-w-[200px]">
          {activeTodo.content}
        </span>
      ) : (
        <span className="typography-ui-label">{t('chat.statusRow.tasksTitle')}</span>
      )}
      <span className="typography-meta flex items-center gap-1 tabular-nums" aria-hidden="true">
        <span className="flex items-center gap-0.5">
          <RiRecordCircleLine className="h-3.5 w-3.5 text-[var(--status-info)]" />
          {statusSummary.active}
        </span>
        <span>·</span>
        <span className="flex items-center gap-0.5">
          <RiTimeLine className="h-3.5 w-3.5" />
          {statusSummary.left}
        </span>
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
    <div className={cn("mb-1", !hasLeftAccessory && "chat-column")} style={STATUS_ROW_CONTAINER_STYLE}>
      <div className={cn("flex items-center justify-between py-0.5 gap-2 h-[1.2rem]", hasLeftAccessory && "px-0.5")}>
        {/* Left: Abort status or Working placeholder or leftAccessory */}
        <div className={cn("flex-1 flex items-center min-w-0", hasLeftAccessory ? "pl-1.5" : "overflow-hidden")}>
          {showAssistantStatus && showAbortStatus ? (
            <div className="flex h-full items-center text-[var(--status-error)] pl-0.5">
              <span className="flex items-center gap-1.5 typography-ui-label">
                <RiCloseCircleLine size={16} aria-hidden="true" />
                {t('chat.statusRow.aborted')}
              </span>
            </div>
          ) : showAssistantStatus && shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              agentName={agentName}
            />
          ) : leftAccessory ? (
            leftAccessory
          ) : null}
        </div>

        {/* Right: Abort (mobile only) + Todo */}
        <div className={cn("relative flex items-center gap-2 flex-shrink-0", hasLeftAccessory ? "pr-1.5" : "-mr-3")} ref={popoverRef}>
          {abortButton}
          {todoTrigger}

          {/* Popover dropdown */}
          {isExpanded && hasTodoContent && (
            <div
              style={{
                maxWidth: "min(28rem, calc(100cqw - 4ch))",
                backgroundColor: "var(--surface-elevated)",
                color: "var(--surface-elevated-foreground)",
              }}
              className={cn(
                "absolute right-0 bottom-full mb-1 z-50",
                "w-max min-w-[200px] rounded-xl p-1",
                "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)]",
                "dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]",
                "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                "duration-150"
              )}
            >
              {/* Header */}
              <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
                <span>{t('chat.statusRow.tasksTitle')}</span>
                <span className="typography-meta tabular-nums">
                  {progress.completed}/{progress.total}
                </span>
              </div>

              {/* Todo list */}
              <div className="px-1 max-h-[200px] overflow-y-auto">
                {visibleTodos.map((todo, index) => (
                  <TodoItemRow key={todo.id ?? `todo-${index}`} todo={todo} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
