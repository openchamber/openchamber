import React from "react";
import {
  getConfigUpdateSnapshot,
  subscribeConfigUpdate,
} from "@/lib/configUpdate";
import { OpenChamberLogo } from "./OpenChamberLogo";

export const ConfigUpdateOverlay: React.FC = () => {
  const [{ isUpdating }, setState] = React.useState(() => getConfigUpdateSnapshot());

  React.useEffect(() => {
    return subscribeConfigUpdate(setState);
  }, []);

  if (!isUpdating) {
    return null;
  }

  // No status text — the update message is internal jargon and reads as noise.
  // The animated logo alone signals "working".
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/90">
      <OpenChamberLogo width={80} height={80} isAnimated />
    </div>
  );
};
