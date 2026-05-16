import React from "react";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/components/icon/Icon";

interface RevertPopoverProps {
  sessionId: string;
  /** Locks all buttons during any restore/revert operation */
  isPanelLocked: boolean;
  /** Show spinner on the "Restore All" button specifically */
  isRestoreAllLoading: boolean;
  /** Message ID being reverted individually (null if none or restore-all) */
  restoringMessageId: string | null;
  /** Fire-and-forget — indicator manages loading state and closing */
  onRestoreAll: () => void;
  /** Fire-and-forget — indicator manages loading state and closing */
  onRevertToMessage: (messageId: string) => void;
}

/**
 * Popover listing reverted messages as a scrollable list.
 * Each item shows a preview with inline "Revert" and "Fork" action buttons.
 * Styled to match the StatusRow todo list dropdown.
 */
export const RevertPopover: React.FC<RevertPopoverProps> = ({
  sessionId,
  isPanelLocked,
  isRestoreAllLoading,
  restoringMessageId,
  onRestoreAll,
  onRevertToMessage,
}) => {
  const { t } = useI18n();
  const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage);
  const revertedMessages = useSessionUIStore(
    React.useCallback(
      (state) => state.revertHistory.get(sessionId)?.revertedMessages ?? [],
      [sessionId],
    ),
  );

  return (
    <div
      style={{
        maxWidth: "min(28rem, calc(100cqw - 4ch))",
        backgroundColor: "var(--surface-elevated)",
        color: "var(--surface-elevated-foreground)",
      }}
      className={cn(
        "w-max min-w-[200px] rounded-xl p-1",
        "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)]",
        "dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]",
        "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
        "duration-150",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
        <span>{t("chat.revertPopover.title")}</span>
        <span className="typography-meta tabular-nums">
          {revertedMessages.length}
        </span>
      </div>

      {/* Reverted messages list — each item has inline action buttons */}
      <div className="px-1 max-h-[200px] overflow-y-auto">
        {revertedMessages.map((msg) => (
          <div
            key={msg.id}
            className="flex items-center gap-1.5 w-full py-1 px-1.5 rounded-lg hover:bg-[var(--surface-hover)] group"
          >
            {/* Message preview text */}
            <span className="flex-1 typography-ui-label text-muted-foreground group-hover:text-foreground truncate min-w-0">
              {msg.preview || t("chat.revertPopover.noTextContent")}
            </span>
            {/* Inline action buttons — locked during any operation */}
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onRevertToMessage(msg.id); }}
                    disabled={isPanelLocked}
                    className={cn(
                      "h-5 px-1.5 flex items-center justify-center rounded text-muted-foreground transition-colors typography-meta",
                      isPanelLocked
                        ? "opacity-30 cursor-not-allowed"
                        : "hover:text-foreground hover:bg-[var(--interactive-hover)]",
                    )}
                    aria-label={t("chat.revertPopover.revert")}
                  >
                    {restoringMessageId === msg.id ? (
                      <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <Icon name="arrow-go-back" className="h-3 w-3" aria-hidden="true" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6} style={{ zIndex: 9999 }}>{t("chat.revertPopover.revert")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); forkFromMessage(sessionId, msg.id); }}
                    disabled={isPanelLocked}
                    className={cn(
                      "h-5 px-1.5 flex items-center justify-center rounded text-muted-foreground transition-colors typography-meta",
                      isPanelLocked
                        ? "opacity-30 cursor-not-allowed"
                        : "hover:text-foreground hover:bg-[var(--interactive-hover)]",
                    )}
                    aria-label={t("chat.revertPopover.fork")}
                  >
                    <Icon name="git-branch" className="h-3 w-3" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6} style={{ zIndex: 9999 }}>{t("chat.revertPopover.fork")}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        ))}
        {revertedMessages.length === 0 && (
          <div className="px-2 py-1 typography-ui-label text-muted-foreground">
            {t("chat.revertPopover.noTextContent")}
          </div>
        )}
      </div>

      {/* Actions footer */}
      <div className="px-1 pt-0.5">
        <button
          type="button"
          onClick={onRestoreAll}
          disabled={isPanelLocked}
          className={cn(
            "w-full flex items-center gap-2 py-1.5 px-2 rounded-lg transition-colors typography-ui-label",
            isPanelLocked
              ? "opacity-50 cursor-not-allowed text-muted-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-[var(--surface-hover)]",
          )}
        >
          {isRestoreAllLoading ? (
            <Icon name="loader-4" className="h-3.5 w-3.5 flex-shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <Icon name="arrow-go-forward" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          )}
          <span>{t("chat.revertPopover.restoreAll")}</span>
        </button>
      </div>
    </div>
  );
};
