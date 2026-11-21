export const foldContextRows = <TRow extends { readonly id: string }>(
    rows: readonly TRow[],
    options: { limit: number; showAll: boolean; keepId: string | null },
) => {
    const shown = options.showAll ? [...rows] : rows.slice(0, options.limit);
    const kept = options.keepId === null ? undefined : rows.find((row) => row.id === options.keepId);
    const visible = kept && !shown.includes(kept)
        ? [...shown.slice(0, options.limit - 1), kept]
        : shown;
    return { visible, hiddenCount: rows.length - visible.length };
};
