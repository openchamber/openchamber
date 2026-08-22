import type { ReactNode } from "react";

export function ChartCard({
  title,
  aside,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      {(title || aside) && (
        <div className="mb-2 flex items-baseline gap-2">
          <span className="typography-ui-label text-foreground">{title}</span>
          {aside ? (
            <span className="ml-auto typography-micro text-muted-foreground">
              {aside}
            </span>
          ) : null}
        </div>
      )}
      {children}
    </div>
  );
}
