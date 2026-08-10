import type { ReactNode } from "react";
import { seriesColor } from "./charts/palette";

export interface RankedListItem {
  id: string;
  title: ReactNode;
  values: ReactNode[];
}

interface RankedListProps {
  items: readonly RankedListItem[];
  empty: string;
  onOpen?: (id: string) => void;
  openLabel?: string;
}

export function RankedList({
  items,
  empty,
  onOpen,
  openLabel,
}: RankedListProps) {
  if (items.length === 0) {
    return <p className="typography-meta text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="flex flex-col -mx-2 -my-1.5">
      {items.map((item, index) => {
        const inner = (
          <>
            <span className="w-[1ch] shrink-0 text-right text-xs text-muted-foreground">
              {index + 1}
            </span>
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: seriesColor(index) }}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {item.title}
            </span>
            {item.values?.map((val) => (
              <span className="text-sm tabular-nums text-muted-foreground">
                {val}
              </span>
            ))}
          </>
        );
        return (
          <li key={item.id}>
            {onOpen ? (
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-subtle"
                onClick={() => onOpen(item.id)}
                aria-label={`${openLabel ?? ""}: ${item.title}`}
              >
                {inner}
              </button>
            ) : (
              <div className="flex items-center gap-2.5 px-2 py-1.5">
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
