import React from "react";
import type { QuotaProviderId, UsageWindow } from "@/types";
import {
  activateGiftReset,
  type QuotaGiftResetType,
} from "@/lib/quota/fetchQuota";
import { useQuotaStore } from "@/stores/useQuotaStore";
import { useUIStore } from "@/stores/useUIStore";
import { useI18n } from "@/lib/i18n";
import { formatDateTimeForPreference } from "@/lib/timeFormat";
import { Icon } from "@/components/icon/Icon";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "@/components/ui";
import { cn } from "@/lib/utils";

const giftResetTypeForWindow = (
  windowSeconds: number | null,
): QuotaGiftResetType | undefined => {
  if (windowSeconds === 5 * 60 * 60) return "FIVE_HOUR";
  if (windowSeconds === 7 * 24 * 60 * 60) return "WEEK";
  return undefined;
};

// Under an hour left (or already expired) the gift is burning —
// the button switches from the success tint to the warning one.
const GIFT_RESET_URGENT_MS = 60 * 60 * 1000;

// A fresh limit needs no reset: while 95% or more of the window remains,
// the button stays disabled. Rounded to match the percent label the user sees.
const GIFT_RESET_FRESH_REMAINING_PERCENT = 95;

/**
 * Gift limit reset action for z.ai windows. Renders nothing unless the window
 * carries a gift reset and its span maps to a known reset type.
 */
export const UsageGiftResetButton: React.FC<{
  window: UsageWindow;
  providerId: QuotaProviderId;
}> = ({ window, providerId }) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore(
    (state) => state.timeFormatPreference,
  );
  const fetchProviderQuota = useQuotaStore((state) => state.fetchProviderQuota);
  const [pending, setPending] = React.useState(false);

  const giftReset = window.giftReset ?? null;
  const resetType = giftResetTypeForWindow(window.windowSeconds);
  if (!giftReset || !resetType) return null;

  const urgent = giftReset.expireAt - Date.now() < GIFT_RESET_URGENT_MS;
  // A fresh limit needs no reset: while 95% or more of the window remains,
  // the button stays disabled. Rounded to match the percent label the user sees.
  const remaining =
    window.remainingPercent ??
    (window.usedPercent != null ? 100 - window.usedPercent : null);
  const noResetNeeded =
    remaining != null &&
    Math.round(remaining) >= GIFT_RESET_FRESH_REMAINING_PERCENT;

  const expiresLabel = formatDateTimeForPreference(
    giftReset.expireAt,
    timeFormatPreference,
    {
      dateStyle: "medium",
      timeStyle: "short",
    },
  );

  const handleActivate = async () => {
    setPending(true);
    try {
      await activateGiftReset(providerId, giftReset.recordId, resetType);
      toast.success(t("settings.usage.page.window.giftResetActivated"));
      void fetchProviderQuota(providerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      toast.error(t("settings.usage.page.window.giftResetActivateFailed"), {
        description: message,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The span keeps the tooltip hoverable while the button is disabled:
            disabled buttons do not fire pointer events themselves. */}
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={cn(
              "size-6 shrink-0 p-0",
              urgent
                ? "bg-(--status-warning)/15 text-status-warning hover:bg-(--status-warning)/25 hover:text-status-warning"
                : "bg-(--status-success)/15 text-status-success hover:bg-(--status-success)/25 hover:text-status-success",
            )}
            onClick={() => void handleActivate()}
            disabled={pending || noResetNeeded}
            aria-label={`${t("settings.usage.page.window.giftResetAria")}${noResetNeeded ? `. ${t("settings.usage.page.window.giftResetNotNeeded")}` : ""}`}
          >
            <Icon
              name={pending ? "loader-4" : "gift"}
              className={pending ? "size-3.5 animate-spin" : "size-3.5"}
            />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {t("settings.usage.page.window.giftResetExpires", {
          time: expiresLabel,
        })}
        {noResetNeeded ? (
          <>
            .<br />
            {t("settings.usage.page.window.giftResetNotNeeded")}
          </>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
};
