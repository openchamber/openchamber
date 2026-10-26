import React from "react";
import { useChatSessionSelection } from './chatColumnSession';
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";
import { BackgroundWorkButton } from "./components/BackgroundWorkButton";

// The floating assistant-status chip that hovers above the composer while the
// agent works ("Claude is working…"). ONLY that. The composer's
// own bar — pending changes, todos dropdown — is ComposerStatusBar: they used
// to share this component, and every restyle of this chip (surface, placement)
// silently dragged the composer bar and its dropdown along with it.

const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

interface StatusRowProps {
  isWorking?: boolean;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number; resetsAt?: number } | null;
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
  /** Set while the turn waits on work OpenCode can move to the background. */
  onBackground?: () => void;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  statusText = null,
  isGenericStatus,
  isWaitingForPermission,
  abortActive,
  retryInfo,
  agentName,
  modelName,
  providerId,
  onBackground,
}) => {
  const currentSessionId = useChatSessionSelection().sessionId;

  const shouldRenderPlaceholder = !abortActive;
  const hasContent = isWorking;

  if (!hasContent) {
    return null;
  }

  return (
    <div
      // The row renders inside the composer-anchored overlay, which owns the
      // distance to the input and the horizontal column (the same ones the
      // scroll-to-bottom pill uses).
      style={STATUS_ROW_CONTAINER_STYLE}
    >
      {/* 28px, the toolbar control height, shared with the scroll-to-bottom
          pill that takes over this label away from the live edge. */}
      {/* The chip lives here, not on the container: the root above is
          an inline-size query container, whose width ignores its children —
          a shrink-to-fit wrapper around it always collapsed to zero. */}
      {/* Same start inset the arrow slot gives the icon: 1px border + 6px.
          The logo box is 16px like the arrow icon, its mark normalized in
          WorkingPlaceholder, so the visible marks land on the same line.
          pe-2 evens out the far side: text glyph to edge lands ~10px, the
          same optical gap as the start. */}
      <div className="oc-surface-floating inline-flex w-max max-w-full items-center gap-2 h-7 whitespace-nowrap rounded-full [corner-shape:round] ps-1.5 pe-2">
        {/* overflow-x-clip: hiding one axis turns the other into `auto`, and a
            sub-pixel overshoot of the label (zoom, font metrics) gave the chip
            its own scrollbar. Clipping both axes cut descenders off at the
            label's 16px line box, so only the width is clipped. */}
        <div className="flex items-center min-w-0 gap-2 overflow-x-clip">
          {shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              agentName={agentName}
              modelName={modelName}
              providerId={providerId}
            />
          ) : null}
        </div>
        {/* -me-1.5 keeps the button's right edge 3px inside the border now
            that the chip's pe shrank to 8px. */}
        {onBackground ? <BackgroundWorkButton onClick={onBackground} className="-me-1.5 h-6 w-6" /> : null}
      </div>
    </div>
  );
};
