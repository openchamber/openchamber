import React from "react";
import {
  getConfigUpdateSnapshot,
  subscribeConfigUpdate,
} from "@/lib/configUpdate";
import { Icon } from "@/components/icon/Icon";

export const ConfigUpdateOverlay: React.FC = () => {
  const [{ isUpdating, message }, setState] = React.useState(() => getConfigUpdateSnapshot());

  React.useEffect(() => {
    return subscribeConfigUpdate(setState);
  }, []);

  if (!isUpdating) {
    return null;
  }

  return (
    <div className="fixed top-3 right-3 z-[9999] flex items-center gap-2 rounded-lg border border-border/40 bg-[var(--surface-elevated)] px-3 py-1.5 shadow-lg">
      <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      <span className="typography-micro text-muted-foreground max-w-48 truncate">{message}</span>
    </div>
  );
};
