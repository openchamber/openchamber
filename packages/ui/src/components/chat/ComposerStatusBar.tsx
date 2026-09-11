import React from "react";
import { useSessionUIStore } from '@/sync/session-ui-store';
import { cn } from "@/lib/utils";
import { useDirectorySync } from "@/sync/sync-context";
import type { Todo } from "@opencode-ai/sdk/v2/client";
import { useUIStore } from "@/stores/useUIStore";
import { useTodosPersistStore } from "@/stores/useTodosPersistStore";
import { isVSCodeRuntime } from "@/lib/desktop";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/components/icon/Icon";
import { useI18n } from "@/lib/i18n";

// The bar that sits in the composer stack: pending-changes accessory, abort
// status, and the todos dropdown. Deliberately a separate component from
// StatusRow — that one is the floating assistant-status chip above the
// composer, and sharing markup meant every restyle of the chip (glass,
// placement) silently restyled this bar and its dropdown too.

type TodoItem = Todo & { id?: string };

const COMPOSER_STATUS_BAR_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "composer-status-bar" };

const statusConfig = {
  in_progress: { textClassName: "text-foreground" },
  pending: { textClassName: "text-foreground" },
  completed: { textClassName: "text-muted-foreground line-through" },
  cancelled: { textClassName: "text-muted-foreground line-through" },
};

const priorityClassName = {
  high: "text-[var(--status-warning)]",
  medium: "text-muted-foreground",
  low: "text-muted-foreground/70",
};

const priorityIcon = {
  high: <Icon name="arrow-up-double" className="h-3.5 w-3.5" aria-hidden="true" />,
  medium: <Icon name="arrow-up-s" className="h-3.5 w-3.5" aria-hidden="true" />,
  low: <Icon name="arrow-down-s" className="h-3.5 w-3.5" aria-hidden="true" />,
};

const statusLabelKey = {
  in_progress: "chat.statusRow.todo.status.inProgress",
  pending: "chat.statusRow.todo.status.pending",
  completed: "chat.statusRow.todo.status.completed",
  cancelled: "chat.statusRow.todo.status.cancelled",
};

const priorityLabelKey = {
  high: "chat.statusRow.todo.priority.high",
  medium: "chat.statusRow.todo.priority.medium",
  low: "chat.statusRow.todo.priority.low",
};

// SAFETY: todo.status / todo.priority arrive from the SDK as open strings;
// lookups treat them as candidate keys and every call site falls back to a
// default entry when the value is outside the known set.
const knownStatus = (status: string) =>
  // SAFETY: candidate-key narrowing; misses resolve to undefined and callers fall back.
  status as keyof typeof statusConfig;
const knownPriority = (priority: string) =>
  // SAFETY: candidate-key narrowing; misses resolve to undefined and callers fall back.
  priority as keyof typeof priorityClassName;

const TodoItemRow: React.FC<{ todo: TodoItem }> = ({ todo }) => {
  const { t } = useI18n();
  const config = statusConfig[knownStatus(todo.status)] || statusConfig.pending;
  // SAFETY: the label keys are literal members of the i18n dictionary; the
  // lookup narrows an open SDK string with a known fallback, and t() accepts
  // only the generated key union.
  const statusKey = (statusLabelKey[knownStatus(todo.status)] ?? statusLabelKey.pending) as Parameters<typeof t>[0];
  // SAFETY: same literal-member narrowing as statusKey above.
  const priorityKey = (priorityLabelKey[knownPriority(todo.priority)] ?? priorityLabelKey.medium) as Parameters<typeof t>[0];

  const statusIcon =
    todo.status === "in_progress" ? (
      <Icon name="record-circle" className="h-3.5 w-3.5 text-[var(--status-info)]" aria-hidden="true" />
    ) : todo.status === "completed" ? (
      <Icon name="checkbox-circle" className="h-3.5 w-3.5 text-[var(--status-success)]" aria-hidden="true" />
    ) : (
      <Icon name="time" className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    );

  return (
    <div className="flex items-center min-w-0 py-0.5 gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex-shrink-0">{statusIcon}</span>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          {t(statusKey)}
        </TooltipContent>
      </Tooltip>
      <span className={cn("flex-1 typography-ui-label", config.textClassName)}>
        {todo.content}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "typography-meta flex items-center justify-center flex-shrink-0 leading-none",
              priorityClassName[knownPriority(todo.priority)] ?? priorityClassName.medium,
            )}
          >
            {priorityIcon[knownPriority(todo.priority)] ?? priorityIcon.medium}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {t(priorityKey)}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

const EMPTY_TODOS: TodoItem[] = [];

interface ComposerStatusBarProps {
  showTodos?: boolean;
  leftAccessory?: React.ReactNode;
}

export const ComposerStatusBar: React.FC<ComposerStatusBarProps> = ({
  showTodos = true,
  leftAccessory,
}) => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore(
    React.useCallback(
      (state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null),
      [currentSessionId],
    ),
  );
  const liveTodos = useDirectorySync(
    React.useCallback(
      (state) => {
        if (!showTodos || !currentSessionId) return EMPTY_TODOS;
        return state.todo[currentSessionId] ?? EMPTY_TODOS;
      },
      [currentSessionId, showTodos],
    ),
  );
  const persistedSessionTodos = useTodosPersistStore(
    React.useCallback(
      (state) => (showTodos && currentSessionId && currentSessionDirectory
        ? state.getSessionTodos(currentSessionDirectory, currentSessionId)
        : undefined),
      [currentSessionDirectory, currentSessionId, showTodos],
    ),
  );
  const todos: TodoItem[] = React.useMemo(() => {
    if (!currentSessionId) return EMPTY_TODOS;
    if (liveTodos.length > 0) return liveTodos;
    return persistedSessionTodos ?? EMPTY_TODOS;
  }, [liveTodos, persistedSessionTodos, currentSessionId]);
  const isMobile = useUIStore((state) => state.isMobile);
  const isCompact = isMobile || isVSCodeRuntime();

  const visibleTodos = React.useMemo(() => {
    return todos.filter((todo) => todo.status !== "cancelled");
  }, [todos]);

  const activeTodo = React.useMemo(() => {
    return (
      visibleTodos.find((todo) => todo.status === "in_progress") ||
      visibleTodos.find((todo) => todo.status === "pending") ||
      null
    );
  }, [visibleTodos]);

  const progress = React.useMemo(() => {
    const total = todos.filter((todo) => todo.status !== "cancelled").length;
    const completed = todos.filter((todo) => todo.status === "completed").length;
    return { completed, total };
  }, [todos]);

  const statusSummary = React.useMemo(() => {
    const active = visibleTodos.filter((todo) => todo.status === "in_progress").length;
    const left = visibleTodos.filter((todo) => todo.status === "in_progress" || todo.status === "pending").length;
    return { active, left };
  }, [visibleTodos]);

  const hasTodoContent = showTodos && statusSummary.left > 0;
  const hasLeftAccessory = Boolean(leftAccessory);
  const hasContent = hasTodoContent || hasLeftAccessory;

  const popoverRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      // SAFETY: mousedown targets are DOM nodes; contains() only needs Node.
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

  const todoTrigger = hasTodoContent ? (
    <button
      type="button"
      onClick={toggleExpanded}
      className="flex items-center gap-1 flex-shrink-0 text-muted-foreground"
      aria-label={todoSummaryLabel}
      title={todoSummaryLabel}
    >
      {!isCompact && activeTodo ? (
        <span className="composer-status-bar__active-todo typography-ui-label text-foreground truncate max-w-[200px]">
          {activeTodo.content}
        </span>
      ) : (
        <span className="typography-ui-label">{t('chat.statusRow.tasksTitle')}</span>
      )}
      <span className="typography-meta flex items-center gap-1 tabular-nums" aria-hidden="true">
        <span className="flex items-center gap-0.5">
          <Icon name="record-circle" className="h-3.5 w-3.5 text-[var(--status-info)]" />
          {statusSummary.active}
        </span>
        <span>·</span>
        <span className="flex items-center gap-0.5">
          <Icon name="time" className="h-3.5 w-3.5" />
          {statusSummary.left}
        </span>
      </span>
      {isExpanded ? (
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
      ) : (
        <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
      )}
    </button>
  ) : null;

  if (!hasContent) {
    return null;
  }

  return (
    <div className="mb-2" style={COMPOSER_STATUS_BAR_CONTAINER_STYLE}>
      <div className={cn("flex items-center justify-between gap-2 h-8", hasLeftAccessory && "px-0.5")}>
        {/* Left: abort status | pending-changes accessory */}
        <div className={cn("flex-1 flex items-center min-w-0 gap-2", hasLeftAccessory ? "pl-1.5" : "overflow-x-hidden")}>
          {leftAccessory ?? null}
        </div>

        {/* Right: todos dropdown */}
        <div className={cn("relative flex items-center gap-2 flex-shrink-0", hasLeftAccessory && "pr-1.5")} ref={popoverRef}>
          {todoTrigger}

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
                "duration-150",
              )}
            >
              <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
                <span>{t('chat.statusRow.tasksTitle')}</span>
                <span className="typography-meta tabular-nums">
                  {progress.completed}/{progress.total}
                </span>
              </div>

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
