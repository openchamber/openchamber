import {
  formatCompactNumber,
  formatCostUsd,
  type TopSessionEntry,
} from "@/lib/analytics/aggregate";
import { useSessionUIStore } from "@/sync/session-ui-store";

interface TopSessionsLabels {
  open: string;
  empty: string;
}

interface TopSessionsProps {
  entries: readonly TopSessionEntry[];
  labels: TopSessionsLabels;
  onOpen?: (entry: TopSessionEntry) => void;
}

const dateLabel = (timestamp: number): string =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp),
  );

export function TopSessions({ entries, labels, onOpen }: TopSessionsProps) {
  const handleOpen =
    onOpen ??
    ((entry: TopSessionEntry) => {
      useSessionUIStore.getState().setCurrentSession(entry.id, entry.directory);
    });

  if (entries.length === 0) {
    return (
      <p className="typography-meta text-muted-foreground">{labels.empty}</p>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-2 flex flex-col gap-4">
      <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] divide-y divide-surface-subtle">
        {entries.map((entry) => (
          <li key={entry.id} className="grid col-span-full grid-cols-subgrid">
            <button
              type="button"
              className="grid col-span-full grid-cols-subgrid items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-surface-subtle rounded-md"
              onClick={() => handleOpen(entry)}
              aria-label={`${labels.open}: ${entry.title}`}
            >
              <span className="min-w-0">
                <span className="block truncate typography-ui-label text-foreground">
                  {entry.title}
                </span>
                {entry.projectLabel ? (
                  <span className="block truncate text-xs text-muted-foreground/50">
                    {entry.projectLabel}
                  </span>
                ) : null}
              </span>
              <span className="typography-meta text-muted-foreground">
                {formatCompactNumber(entry.tokens)}
              </span>
              <span className="text-right typography-meta text-muted-foreground">
                {formatCostUsd(entry.cost)}
              </span>
              <span className="text-right typography-micro text-muted-foreground">
                {dateLabel(entry.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
