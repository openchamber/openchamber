import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";

interface SidebarGroupProps {
  label: string;
  count: number;
  storageKey: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

function getStorageKey(storageKey: string, label: string): string {
  return `opencode:sidebar-group:${storageKey}:${label}`;
}

export const SidebarGroup: React.FC<SidebarGroupProps> = ({
  label,
  count,
  storageKey,
  defaultExpanded = true,
  children,
}) => {
  const key = getStorageKey(storageKey, label);
  const contentId = React.useId();

  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return stored === 'true';
    } catch {
      // ignore storage errors
    }
    return defaultExpanded;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(expanded));
    } catch {
      // ignore storage errors
    }
  }, [key, expanded]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className={cn(
          'flex w-full items-center gap-1 rounded-md px-2 py-1 text-start',
          'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
          'hover:bg-[var(--interactive-hover)] transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Icon name="arrow-down-s"
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200',
            !expanded && '-rotate-90 rtl:rotate-90',
          )}
        />
        <span className="flex-1 truncate">{label}</span>
        <span className="ms-1 tabular-nums opacity-60">{count}</span>
      </button>

      <div
        id={contentId}
        hidden={!expanded}
        className="mt-0.5 space-y-0.5 ms-2 ps-3 border-s-2 border-[var(--interactive-border)]"
      >
        {children}
      </div>
    </div>
  );
};
