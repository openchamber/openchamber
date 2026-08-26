import React from "react";
import { useSessionUIStore } from '@/sync/session-ui-store';
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";

// The floating assistant-status chip that hovers above the composer while the
// agent works ("Claude is working…"). ONLY that. The composer's
// own bar — pending changes, todos dropdown — is ComposerStatusBar: they used
// to share this component, and every restyle of this chip (glass, placement)
// silently dragged the composer bar and its dropdown along with it.

const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

interface StatusRowProps {
  isWorking?: boolean;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
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
}) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

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
      {/* h-8 matches the turn footer's real row height: its h-8 action
          buttons define the footer line, with the meta text centered in it. */}
      {/* The glass chip lives here, not on the container: the root above is
          an inline-size query container, whose width ignores its children —
          a shrink-to-fit wrapper around it always collapsed to zero. */}
      <div className="oc-glass-popover inline-flex w-max max-w-full items-center gap-2 h-8 whitespace-nowrap rounded-full [corner-shape:round] px-3">
        <div className="flex items-center min-w-0 gap-2 overflow-x-hidden">
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
      </div>
    </div>
  );
};
