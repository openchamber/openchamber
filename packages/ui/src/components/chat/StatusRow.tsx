import React from "react";
import { useChatSessionSelection } from './chatColumnSession';
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";
import { BackgroundWorkButton } from "./components/BackgroundWorkButton";
import type { AgentStatus } from "@/lib/agentStatus";


const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

interface StatusRowProps {
  isWorking?: boolean;
  status?: AgentStatus | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number; resetsAt?: number } | null;
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
  onBackground?: () => void;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  status = null,
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
      style={STATUS_ROW_CONTAINER_STYLE}
    >
      <div className="oc-surface-floating inline-flex w-max max-w-full items-center gap-2 h-7 whitespace-nowrap rounded-full [corner-shape:round] ps-1.5 pe-2">
        <div className="flex items-center min-w-0 gap-2 overflow-x-clip">
          {shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              status={status}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              agentName={agentName}
              modelName={modelName}
              providerId={providerId}
            />
          ) : null}
        </div>
        {onBackground ? <BackgroundWorkButton onClick={onBackground} className="-me-1.5 h-6 w-6" /> : null}
      </div>
    </div>
  );
};
